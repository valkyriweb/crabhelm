import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as pkg from "../lib/remote-browser-package.mjs";
import { HIDDEN_LOCKFILE, expectedRemoteBrowserClosure, remoteBrowserDependencyInventorySha256, verifyRemoteBrowserClosure } from "../lib/remote-browser-closure.mjs";

// Everything here is synthetic: a throwaway local git repo, inert text "modules" and a fake ELF header.
// Nothing staged is ever imported or executed.
const hash = (d) => createHash("sha256").update(d).digest("hex");
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } }).trim();
const integ = "sha512-" + "A".repeat(86) + "==";
const lockPkg = (v, extra = {}) => ({ version: v, resolved: "https://registry.npmjs.org/x/-/x-" + v + ".tgz", integrity: integ, ...extra });
const LOCK = { lockfileVersion: 3, packages: {
  "node_modules/@modelcontextprotocol/sdk": lockPkg("1.32.0", { dependencies: { zod: "^3" } }),
  "node_modules/zod": lockPkg("3.25.0"),
} };
const SOURCES = {
  "src/v0/engine.mjs": "import './tools.mjs';\nimport './chrome.mjs';\nimport './jev.mjs';\nimport '@modelcontextprotocol/sdk/server/index.js';\n",
  "src/v0/tools.mjs": "export const T = 1;\n",
  "src/v0/chrome.mjs": "export const C = 1;\n",
  "src/v0/jev.mjs": "export const J = 'original bytes that must never ship';\n",
};

function makePlan(t) {
  const dir = mkdtempSync(join(tmpdir(), "rbc-repo-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  const all = { ...SOURCES, "package.json": JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "1.32.0" } }), "package-lock.json": JSON.stringify(LOCK) };
  for (const [p, c] of Object.entries(all)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  git(dir, "add", "-A"); git(dir, "commit", "-qm", "x");
  const revision = git(dir, "rev-parse", "HEAD");
  const plan = pkg.planBrowserPackage({ sourceDir: dir, revision });
  assert.equal(plan.ok, true, JSON.stringify(plan.blockers));
  return { plan, revision };
}

const elf = () => { const b = Buffer.alloc(24); b.write("\x7fELF"); b[4] = 2; b[5] = 1; b.writeUInt16LE(62, 18); return b; };
const depJson = (name, version) => JSON.stringify({ name, version });
function hiddenLock(plan, over = {}) {
  const packages = {};
  for (const p of plan.dependencies.packages) packages[p.path] = { version: p.version, resolved: p.resolved, integrity: p.integrity };
  return JSON.stringify({ name: "remote-browser-donor", lockfileVersion: 3, requires: true, packages, ...over });
}

function fixture(t, { hidden = true } = {}) {
  const { plan, revision } = makePlan(t);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rbc-bundle-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const content = new Map(); // bundle path -> Buffer
  const trustedFiles = new Map(); // independently hashed dependency inventory
  const put = (path, data, mode = 0o600) => {
    const bytes = Buffer.from(data);
    mkdirSync(dirname(join(dir, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, path), bytes, { mode });
    chmodSync(join(dir, path), mode);
    content.set(path, bytes);
    if (path.startsWith("node_modules/")) trustedFiles.set(path, { path, size: bytes.length, sha256: hash(bytes) });
  };
  const drop = (path) => { rmSync(join(dir, path)); content.delete(path); trustedFiles.delete(path); };
  const minimal = pkg.minimalDependencyFiles(plan);
  for (const name of ["package.json", "package-lock.json", ".npmrc"]) put(name, minimal[name]);
  for (const f of plan.files) put("browser-harness/" + f.source, f.origin === "overlay" ? pkg.DEFAULT_OVERLAYS[f.source].text : SOURCES[f.source]);
  put("node_modules/@modelcontextprotocol/sdk/package.json", depJson("@modelcontextprotocol/sdk", "1.32.0"));
  put("node_modules/@modelcontextprotocol/sdk/server/index.js", "// inert\n");
  put("node_modules/zod/package.json", depJson("zod", "3.25.0"));
  if (hidden) put(HIDDEN_LOCKFILE, hiddenLock(plan));
  const chromeBytes = elf();
  put("chrome/chrome", chromeBytes, 0o700);
  const ctx = {
    dir, plan, revision, put, drop, content, trustedFiles,
    descriptor: () => ({ version: 1, directory: dir, platform: "linux-x64", nodeVersion: "22.19.0", chromePath: "chrome/chrome",
      files: [...content].map(([path, b]) => ({ path, size: b.length, sha256: hash(b) })),
      sourcePlanSha256: plan.planSha256, dependenciesLockSha256: plan.dependencies.lockSha256, dependenciesArtifactSha256: "c".repeat(64) }),
    trusted: () => ({ archiveSha256: "c".repeat(64), files: [...trustedFiles.values()] }),
    attestation: () => ({ platform: "linux-x64", node: "22.19.0", chrome: { platform: "linux-x64", version: "130.0.6723.58", sha256: hash(chromeBytes) },
      dependenciesArtifactSha256: "c".repeat(64), dependenciesLockSha256: plan.dependencies.lockSha256 }),
  };
  ctx.verify = (over = {}) => verifyRemoteBrowserClosure({ descriptor: ctx.descriptor(), plan, attestation: ctx.attestation(), trustedHostDependencyInventory: ctx.trusted(), expectedRevision: revision, ...over });
  return ctx;
}
// A digest-consistent forged plan: the body edit is followed by a recomputed planSha256.
const forge = (plan, edit) => { const p = structuredClone(plan); edit(p); p.planSha256 = pkg.remoteBrowserPlanSha256(p); return p; };

test("happy path verifies and keeps archive hash distinct from the inventory hash", (t) => {
  const f = fixture(t);
  const proof = f.verify();
  assert.equal(proof.verified, true);
  assert.equal(proof.hiddenLockfileChecked, true);
  assert.deepEqual(proof.packages.map((p) => p.path), ["node_modules/@modelcontextprotocol/sdk", "node_modules/zod"]);
  assert.equal(proof.dependenciesArtifactSha256, "c".repeat(64));
  assert.equal(proof.dependencyInventorySha256, remoteBrowserDependencyInventorySha256(f.trusted().files));
  assert.notEqual(proof.dependencyInventorySha256, proof.dependenciesArtifactSha256);
  assert.equal(proof.chromeAuxiliaryClosureProven, false);
  assert.equal(proof.sameUidImmutabilityProven, false);
  assert.equal(f.verify({ expectedPlanSha256: f.plan.planSha256 }).verified, true);
});

test("a bundle without npm's hidden lockfile still verifies when the inventory also lacks it", (t) => {
  const f = fixture(t, { hidden: false });
  assert.equal(f.verify().hiddenLockfileChecked, false);
});

test("plan digest recompute matches planner output, survives a JSON round trip and is body-sensitive", (t) => {
  const { plan } = makePlan(t);
  assert.equal(pkg.remoteBrowserPlanSha256(plan), plan.planSha256);
  assert.equal(pkg.remoteBrowserPlanSha256(JSON.parse(JSON.stringify(plan))), plan.planSha256);
  const expected = expectedRemoteBrowserClosure({ plan, platform: "linux-x64", expectedRevision: plan.revision });
  assert.equal(expected.planSha256, plan.planSha256);
  assert.equal(expected.files.get("package.json").sha256, pkg.minimalDependencyFiles(plan).digests["package.json"]);
  assert.equal(expected.files.get("browser-harness/src/v0/jev.mjs").kind, "overlay");
  assert.equal(expected.files.get("browser-harness/src/v0/tools.mjs").sha256, hash(SOURCES["src/v0/tools.mjs"]));
});

test("tampered, blocked or non-OK plans fail", (t) => {
  const f = fixture(t);
  const bad = (edit, re) => assert.throws(() => f.verify({ plan: (() => { const p = structuredClone(f.plan); edit(p); return p; })() }), re);
  bad((p) => { p.files[0].sha256 = "d".repeat(64); }, /does not match planSha256/);
  bad((p) => { p.dependencies.packages[1].version = "9.9.9"; }, /does not match planSha256/);
  bad((p) => { p.ok = false; }, /OK with no blockers/);
  bad((p) => { p.blockers = [{ path: "x", reason: "y" }]; }, /OK with no blockers/);
  bad((p) => { p.totalBytes += 1; }, /totalBytes/);
  bad((p) => { p.planSha256 = "e".repeat(64); }, /does not match planSha256/);
  assert.throws(() => f.verify({ expectedPlanSha256: "e".repeat(64) }), /pinned planSha256/);
  assert.throws(() => f.verify({ expectedRevision: "1".repeat(40) }), /expected revision/);
});

test("digest-consistent forged plans are rejected by structure, pins and recipes", (t) => {
  const f = fixture(t);
  const fails = (edit, re) => assert.throws(() => f.verify({ plan: forge(f.plan, edit) }), re);
  // A forged but self-consistent plan fails the out-of-band pin.
  assert.throws(() => f.verify({ plan: forge(f.plan, (p) => { p.files[0].size += 0; p.bareImports = []; }), expectedPlanSha256: f.plan.planSha256 }), /pinned planSha256/);
  fails((p) => { p.overlays[0].recipe = "evil"; }, /overlay record differs from reviewed recipe/);
  fails((p) => { const o = p.files.find((x) => x.origin === "overlay"); o.sha256 = "d".repeat(64); p.overlays[0].overlaySha256 = o.sha256; }, /overlay bytes differ/);
  fails((p) => { const o = p.files.find((x) => x.origin === "overlay"); o.origin = "git"; p.overlays = []; }, /original bytes/);
  fails((p) => { p.dependencies.packages[1].path = "node_modules/zod/../x"; }, /./);
  fails((p) => { p.dependencies.packages[1].os = ["darwin"]; }, /os\/cpu differ/);
  fails((p) => { p.dependencies.entries["node_modules/zod"].os = ["darwin"]; p.dependencies.packages[1].os = ["darwin"]; }, /exclude the target platform/);
  fails((p) => { p.dependencies.entries["node_modules/zod"].hasInstallScript = true; }, /disallowed lock property/);
  fails((p) => { p.dependencies.entries["node_modules/zod"].resolved = "https://evil.example/z.tgz"; p.dependencies.packages[1].resolved = "https://evil.example/z.tgz"; }, /registry tarball/);
  fails((p) => { p.dependencies.packages[0].version = "1.33.0"; p.dependencies.entries["node_modules/@modelcontextprotocol/sdk"].version = "1.33.0"; }, /pinned SDK/);
  fails((p) => { p.bareImports = ["left-pad"]; }, /bare import/);
  fails((p) => { p.files.push({ ...p.files[0], source: "src/v0/zzz.mjs" }); p.totalBytes += p.files[0].size; }, /./);
  fails((p) => { p.files[0].source = "../escape.mjs"; }, /./);
});

test("source and overlay bytes must match the plan exactly", (t) => {
  let f = fixture(t); f.put("browser-harness/src/v0/tools.mjs", "export const T = 2;\n");
  assert.throws(() => f.verify(), /planned source bytes differ/);
  f = fixture(t); f.put("browser-harness/src/v0/jev.mjs", SOURCES["src/v0/jev.mjs"]);
  assert.throws(() => f.verify(), /planned overlay bytes differ/);
});

test("minimal package, lock and npmrc bytes must match the plan", (t) => {
  for (const name of ["package.json", "package-lock.json", ".npmrc"]) {
    const f = fixture(t); f.put(name, f.content.get(name).toString() + " ");
    assert.throws(() => f.verify(), /planned dependency-manifest bytes differ/, name);
  }
  const f = fixture(t); f.drop(".npmrc");
  assert.throws(() => f.verify(), /planned file is missing/);
});

test("extra source, root, Chrome-adjacent, package, dot-metadata and .bin paths fail", (t) => {
  const cases = [
    ["browser-harness/src/v0/extra.mjs", /unexpected bundle path|planned/],
    ["browser-harness/package.json", /unexpected bundle path/],
    ["unlisted-root-file", /unexpected bundle path/],
    ["chrome/libaux.so", /unexpected bundle path/],
    ["node_modules/evil/package.json", /unplanned node_modules path/],
    ["node_modules/@modelcontextprotocol/other/package.json", /unplanned node_modules path/],
    ["node_modules/zod/node_modules/inner/package.json", /unplanned nested node_modules path/],
    ["node_modules/zod/node_modules/.bin/tool", /\.bin is not allowed/],
    ["node_modules/.bin/tool", /\.bin is not allowed/],
    ["node_modules/.modules.yaml", /root metadata other than the hidden lockfile/],
    ["node_modules/.cache/x", /root metadata other than the hidden lockfile/],
    ["node_modules/loose-file", /unplanned node_modules path/],
  ];
  for (const [path, re] of cases) {
    const f = fixture(t); f.put(path, "x");
    assert.throws(() => f.verify(), re, path);
  }
});

test("missing or wrong package identity fails", (t) => {
  let f = fixture(t); f.drop("node_modules/zod/package.json");
  f.put("node_modules/zod/index.js", "// inert\n");
  assert.throws(() => f.verify(), /no package\.json/);
  f = fixture(t); f.put("node_modules/zod/package.json", depJson("zodd", "3.25.0"));
  assert.throws(() => f.verify(), /package identity differs/);
  f = fixture(t); f.put("node_modules/zod/package.json", depJson("zod", "3.25.1"));
  assert.throws(() => f.verify(), /package identity differs/);
  f = fixture(t); f.put("node_modules/zod/package.json", "{not json");
  assert.throws(() => f.verify(), /not valid JSON/);
});

test("a trusted inventory is mandatory and must match the archive and every file exactly", (t) => {
  const f = fixture(t);
  assert.throws(() => f.verify({ trustedHostDependencyInventory: undefined }), /trusted host-derived dependency inventory is required/);
  assert.throws(() => f.verify({ trustedHostDependencyInventory: null }), /trusted host-derived dependency inventory is required/);
  const t0 = f.trusted();
  assert.throws(() => f.verify({ trustedHostDependencyInventory: { ...t0, archiveSha256: "d".repeat(64) } }), /different dependency archive/);
  const changed = f.trusted(); changed.files[0] = { ...changed.files[0], sha256: "d".repeat(64) };
  assert.throws(() => f.verify({ trustedHostDependencyInventory: changed }), /differs from the trusted inventory/);
  const sized = f.trusted(); sized.files[0] = { ...sized.files[0], size: sized.files[0].size + 1 };
  assert.throws(() => f.verify({ trustedHostDependencyInventory: sized }), /differs from the trusted inventory/);
  const missing = f.trusted(); missing.files.pop();
  assert.throws(() => f.verify({ trustedHostDependencyInventory: missing }), /differs from the trusted inventory/);
  const extra = f.trusted(); extra.files.push({ path: "node_modules/zod/ghost.js", size: 1, sha256: "d".repeat(64) });
  assert.throws(() => f.verify({ trustedHostDependencyInventory: extra }), /lists files that the bundle lacks/);
  const dup = f.trusted(); dup.files.push(dup.files[0]);
  assert.throws(() => f.verify({ trustedHostDependencyInventory: dup }), /unique node_modules paths/);
  const outside = f.trusted(); outside.files[0] = { ...outside.files[0], path: "package.json" };
  assert.throws(() => f.verify({ trustedHostDependencyInventory: outside }), /unique node_modules paths/);
  const lied = { ...f.trusted(), dependencyInventorySha256: "d".repeat(64) };
  assert.throws(() => f.verify({ trustedHostDependencyInventory: lied }), /dependencyInventorySha256 does not match/);
  assert.throws(() => f.verify({ trustedHostDependencyInventory: { archiveSha256: "c".repeat(64), files: [], extra: 1 } }), /trusted dependency inventory must be/);
  const descriptor = f.descriptor();
  assert.throws(() => f.verify({ descriptor, trustedHostDependencyInventory: { archiveSha256: "c".repeat(64), files: descriptor.files } }), /must not be the descriptor's own inventory/);
});

test("the hidden lockfile needs inventory binding and must agree with the plan", (t) => {
  let f = fixture(t);
  const noHidden = f.trusted(); noHidden.files = noHidden.files.filter((x) => x.path !== HIDDEN_LOCKFILE);
  assert.throws(() => f.verify({ trustedHostDependencyInventory: noHidden }), /differs from the trusted inventory|not bound/);
  f = fixture(t); f.drop(HIDDEN_LOCKFILE);
  const withHidden = f.trusted(); withHidden.files.push({ path: HIDDEN_LOCKFILE, size: 1, sha256: "d".repeat(64) });
  assert.throws(() => f.verify({ trustedHostDependencyInventory: withHidden }), /lists files that the bundle lacks/);
  const mutate = (edit, re) => { const g = fixture(t); const h = JSON.parse(hiddenLock(g.plan)); edit(h); g.put(HIDDEN_LOCKFILE, JSON.stringify(h)); assert.throws(() => g.verify(), re); };
  mutate((h) => { h.packages["node_modules/evil"] = { version: "1.0.0" }; }, /membership differs/);
  mutate((h) => { delete h.packages["node_modules/zod"]; }, /membership differs/);
  mutate((h) => { h.packages["node_modules/zod"].version = "3.25.1"; }, /entry differs from the plan/);
  mutate((h) => { h.packages["node_modules/zod"].integrity = "sha512-" + "B".repeat(86) + "=="; }, /entry differs from the plan/);
  mutate((h) => { h.lockfileVersion = 2; }, /lockfileVersion 3/);
  f = fixture(t); f.put(HIDDEN_LOCKFILE, "{broken");
  assert.throws(() => f.verify(), /not valid JSON/);
});

test("runtime, platform, lock, archive and Chrome mismatches fail", (t) => {
  const f = fixture(t);
  const att = (edit) => { const a = f.attestation(); edit(a); return a; };
  const desc = (edit) => { const d = f.descriptor(); edit(d); return d; };
  assert.throws(() => f.verify({ attestation: att((a) => { a.chrome.sha256 = "d".repeat(64); }) }), /Chrome binary digest differs/);
  assert.throws(() => f.verify({ attestation: att((a) => { a.dependenciesLockSha256 = "d".repeat(64); }) }), /lock digest differs/);
  assert.throws(() => f.verify({ attestation: att((a) => { a.dependenciesArtifactSha256 = "d".repeat(64); }) }), /archive digest differs/);
  assert.throws(() => f.verify({ attestation: att((a) => { a.platform = "linux-arm64"; a.chrome.platform = "linux-arm64"; }) }), /platform\/node differ/);
  assert.throws(() => f.verify({ attestation: att((a) => { a.node = "22.20.0"; }) }), /platform\/node differ/);
  assert.throws(() => f.verify({ attestation: att((a) => { a.platform = "darwin-arm64"; }) }), /attestation is invalid/);
  assert.throws(() => f.verify({ attestation: undefined }), /attestation is invalid/);
  assert.throws(() => f.verify({ platform: "linux-arm64" }), /differ from the attestation/);
  assert.throws(() => f.verify({ nodeVersion: "23.0.0" }), /differ from the attestation/);
  assert.throws(() => f.verify({ descriptor: desc((d) => { d.sourcePlanSha256 = "d".repeat(64); }) }), /sourcePlanSha256 differs/);
  assert.throws(() => f.verify({ descriptor: desc((d) => { d.dependenciesLockSha256 = "d".repeat(64); }) }), /lock digest differs/);
  assert.throws(() => f.verify({ descriptor: desc((d) => { d.dependenciesArtifactSha256 = "d".repeat(64); }) }), /archive digest differs/);
  assert.throws(() => f.verify({ descriptor: desc((d) => { d.nodeVersion = "22.18.0"; }) }), /platform\/node differ/);
  assert.throws(() => f.verify({ descriptor: desc((d) => { d.extra = true; }) }), /missing or unexpected fields/);
  assert.throws(() => f.verify({ descriptor: desc((d) => { d.files[0].mode = 0o777; }) }), /file entries must be/);
  assert.throws(() => f.verify({ descriptor: desc((d) => { d.chromePath = "package.json"; }) }), /Chrome must be the attested executable/);
  const inside = fixture(t); inside.put("node_modules/zod/chrome", elf(), 0o700);
  assert.throws(() => inside.verify({ descriptor: { ...inside.descriptor(), chromePath: "node_modules/zod/chrome" }, attestation: { ...inside.attestation(), chrome: { ...inside.attestation().chrome, sha256: hash(elf()) } } }), /Chrome path collides/);
  const swapped = fixture(t); swapped.put("chrome/chrome", Buffer.concat([elf(), Buffer.from("x")]), 0o700);
  assert.throws(() => swapped.verify({ attestation: f.attestation() }), /Chrome binary digest differs/);
});

test("full bundle verification still rejects symlinks, writable paths and unlisted files", (t) => {
  let f = fixture(t); symlinkSync("package.json", join(f.dir, "link"));
  assert.throws(() => f.verify(), /nonregular/);
  f = fixture(t); symlinkSync("package.json", join(f.dir, "node_modules/.bin"));
  assert.throws(() => f.verify(), /nonregular/);
  f = fixture(t); rmSync(join(f.dir, "node_modules/zod/package.json"));
  symlinkSync(join(f.dir, "package.json"), join(f.dir, "node_modules/zod/package.json"));
  assert.throws(() => f.verify(), /nonregular|changed|unexpected/);
  for (const path of ["", "node_modules", "node_modules/zod/package.json", "browser-harness/src/v0/tools.mjs"]) {
    f = fixture(t); chmodSync(join(f.dir, path), path.endsWith(".json") || path.endsWith(".mjs") ? 0o622 : 0o722);
    assert.throws(() => f.verify(), /writable/, path || "root");
  }
  f = fixture(t); writeFileSync(join(f.dir, "unlisted"), "x");
  assert.throws(() => f.verify(), /unexpected/);
  f = fixture(t); writeFileSync(join(f.dir, "node_modules/zod/package.json"), depJson("zod", "3.25.0") + " ");
  assert.throws(() => f.verify(), /changed/);
});

test("dependency inventory digest is canonical, order independent and content sensitive", () => {
  const a = { path: "node_modules/a/x", size: 1, sha256: "a".repeat(64) }, b = { path: "node_modules/b/y", size: 2, sha256: "b".repeat(64) };
  assert.equal(remoteBrowserDependencyInventorySha256([a, b]), remoteBrowserDependencyInventorySha256([b, a]));
  assert.notEqual(remoteBrowserDependencyInventorySha256([a, b]), remoteBrowserDependencyInventorySha256([a, { ...b, size: 3 }]));
  assert.throws(() => remoteBrowserDependencyInventorySha256([a, a]), /duplicate/);
  assert.throws(() => remoteBrowserDependencyInventorySha256([{ ...a, extra: 1 }]), /invalid/);
});
