import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { deriveTrustedHostDependencyInventory, preflightPython3 } from "../lib/remote-browser-archive.mjs";
import { remoteBrowserDependencyInventorySha256 } from "../lib/remote-browser-closure.mjs";

// Synthetic, inert, in-memory tar.gz fixtures built by a tiny writer; nothing is extracted or executed.
const hash = (d) => createHash("sha256").update(d).digest("hex");
const PY = process.env.PYTHON3 ?? "/usr/bin/python3";
const octal = (n, w) => n.toString(8).padStart(w - 1, "0") + "\0";
function header(name, size, type, nameBytes = Buffer.from(name)) {
  const h = Buffer.alloc(512);
  nameBytes.copy(h, 0, 0, 100);
  h.write(octal(type === "5" ? 0o755 : 0o644, 8), 100); h.write(octal(0, 8), 108); h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124); h.write(octal(0, 12), 136); h.write("        ", 148); h.write(type, 156); h.write("ustar \0", 257);
  h.write(octal([...h].reduce((a, b) => a + b, 0), 7).replace("\0", "\0 ").slice(0, 8), 148);
  return h;
}
const pad = (b) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
function entry({ name, body = "", type = "0", nameBytes }) {
  const data = Buffer.from(body);
  return Buffer.concat([header(name, type === "0" || type === "L" || type === "x" ? data.length : 0, type, nameBytes), type === "0" || type === "L" || type === "x" ? pad(data) : Buffer.alloc(0)]);
}
const tar = (list) => Buffer.concat([...list.map(entry), Buffer.alloc(1024)]);

const PKG = '{"name":"r"}\n', LOCK = '{"lockfileVersion":3}\n';
const roots = { "package.json": { sha256: hash(PKG), size: PKG.length }, "package-lock.json": { sha256: hash(LOCK), size: LOCK.length } };
const base = () => [
  { name: "package.json", body: PKG }, { name: "package-lock.json", body: LOCK },
  { name: "node_modules/", type: "5" }, { name: "node_modules/a/", type: "5" },
  { name: "node_modules/a/package.json", body: '{"name":"a"}' }, { name: "node_modules/.package-lock.json", body: "{}" },
];

function fixture(t, list, { raw } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rba-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bytes = raw ?? gzipSync(tar(list));
  const archivePath = join(dir, "browser-dependencies-linux-x64.tar.gz");
  writeFileSync(archivePath, bytes);
  return { dir, archivePath, expectedArchiveSha256: hash(bytes), python3: PY, expectedRootFiles: roots };
}
const derive = (f, o = {}) => deriveTrustedHostDependencyInventory({ ...f, ...o });
const rejects = (t, list, re, o) => assert.throws(() => derive(fixture(t, list), o), re);

test("python3 preflight is explicit", () => {
  assert.match(preflightPython3(PY), /^3\./);
  assert.throws(() => preflightPython3("python3"), /absolute/);
  assert.throws(() => preflightPython3("/nonexistent/python3"), /not executable/);
});

test("derives exact inventory using the existing digest helper", (t) => {
  const f = fixture(t, base());
  const r = derive(f);
  assert.equal(r.archiveSha256, f.expectedArchiveSha256);
  assert.deepEqual(r.files, [
    { path: "node_modules/.package-lock.json", size: 2, sha256: hash("{}") },
    { path: "node_modules/a/package.json", size: 12, sha256: hash('{"name":"a"}') },
  ]);
  assert.equal(r.dependencyInventorySha256, remoteBrowserDependencyInventorySha256(r.files));
  assert.deepEqual(Object.keys(r).sort(), ["archiveSha256", "dependencyInventorySha256", "files"]);
});

test("GNU long name and PAX path are supported", (t) => {
  const long = "node_modules/" + "d".repeat(120) + "/f.js";
  const pax = `${(" path=node_modules/p/q.js\n").length + 2} path=node_modules/p/q.js\n`;
  const list = [...base(), { name: "././@LongLink", type: "L", body: long + "\0" }, { name: "x", body: "1" }, { name: "pax", type: "x", body: pax }, { name: "y", body: "2" }];
  const r = derive(fixture(t, list));
  assert.ok(r.files.some((x) => x.path === long));
  assert.ok(r.files.some((x) => x.path === "node_modules/p/q.js"));
});

test("rejects archive hash mismatch and a wrong root file before trust", (t) => {
  assert.throws(() => derive(fixture(t, base()), { expectedArchiveSha256: "0".repeat(64) }), /SHA-256 differs/);
  assert.throws(() => derive(fixture(t, base()), { expectedRootFiles: { ...roots, "package.json": { sha256: "1".repeat(64) } } }), /root file differs/);
  assert.throws(() => derive(fixture(t, base().filter((e) => e.name !== "package-lock.json"))), /lacks root file/);
});

test("rejects bad paths and roots", (t) => {
  const bad = (name, re, extra = {}) => rejects(t, [...base(), { name, body: "x", ...extra }], re);
  bad("node_modules/../x", /canonical/);
  bad("/node_modules/x", /canonical/);
  bad("node_modules/a\\b", /canonical/);
  bad("node_modules/a\x01b", /canonical/);
  bad("./node_modules/x", /canonical/);
  bad("node_modules//x", /canonical/);
  bad("node_modules/a/package.json", /duplicate/);
  bad("node_modules/.bin/x", /\.bin/);
  bad("node_modules/.cache", /root metadata/);
  bad("other/x", /unknown archive root/);
  bad(".npmrc", /unknown archive root/);
  bad("node_modules/a/package.json/x", /prefix collision/);
  rejects(t, [...base(), { name: "stray/", type: "5" }], /unknown archive root/);
  rejects(t, [...base(), { name: "node_modules/\xff", nameBytes: Buffer.from([...Buffer.from("node_modules/"), 0xff]), body: "x" }], /rejected/);
});

test("rejects links, special entries and native bodies", (t) => {
  for (const type of ["1", "2", "3", "4", "6", "g", "K", "S"]) rejects(t, [...base(), { name: "node_modules/l", type }], /rejected/);
  rejects(t, [...base(), { name: "node_modules/a/x.node", body: "x" }], /native/);
  rejects(t, [...base(), { name: "node_modules/a/x.js", body: "\x7fELF...." }], /native/);
  rejects(t, [...base(), { name: "node_modules/a/y.js", body: "MZ.." }], /native/);
  for (const magic of ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]) {
    rejects(t, [...base(), { name: "node_modules/a/native.dat", body: Buffer.concat([Buffer.from(magic, "hex"), Buffer.alloc(16)]) }], /native/);
  }
});

test("enforces metadata cap before reading the body and manifest caps", (t) => {
  // Header claims a 1 MiB long name but supplies no body: only a pre-read check can reject by cap reason.
  const lie = Buffer.concat([...base().map(entry), header("././@LongLink", 1024 * 1024, "L")]);
  assert.throws(() => derive(fixture(t, null, { raw: gzipSync(Buffer.concat([lie, Buffer.alloc(1024)])) })), /metadata record exceeds cap/);
  rejects(t, [...base(), { name: "node_modules/big", body: "x".repeat(10) }], /too many tar members|file or byte limit/, { limits: { files: 2 } });
  rejects(t, [...base(), { name: "x" }], /./, { limits: { bytes: 5 } });
});

test("rejects trailing data, non-gzip and truncated input", (t) => {
  const good = gzipSync(Buffer.concat([tar(base()), Buffer.from("junk")]));
  assert.throws(() => derive(fixture(t, null, { raw: good })), /after tar end/);
  assert.throws(() => derive(fixture(t, null, { raw: Buffer.from("not gzip") })), /rejected/);
  assert.throws(() => derive(fixture(t, null, { raw: gzipSync(tar(base())).subarray(0, 40) })), /rejected/);
});

test("rejects symlinked archive and symlinked ancestors", (t) => {
  const f = fixture(t, base());
  const link = join(f.dir, "link.tgz");
  symlinkSync(f.archivePath, link);
  assert.throws(() => derive(f, { archivePath: link }), /symlink/);
  mkdirSync(join(f.dir, "real"));
  symlinkSync(join(f.dir, "real"), join(f.dir, "alias"));
  writeFileSync(join(f.dir, "real", "a.tgz"), "x");
  assert.throws(() => derive(f, { archivePath: join(f.dir, "alias", "a.tgz") }), /symlink/);
  assert.throws(() => derive(f, { archivePath: "relative.tgz" }), /absolute/);
});

test("requires caller-held digest, python path and exactly one root source", (t) => {
  const f = fixture(t, base());
  assert.throws(() => derive(f, { expectedArchiveSha256: undefined }), /caller-held/);
  assert.throws(() => derive(f, { python3: "python3" }), /absolute/);
  assert.throws(() => derive(f, { plan: {} }), /exactly one/);
});
