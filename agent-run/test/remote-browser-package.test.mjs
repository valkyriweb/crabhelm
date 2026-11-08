import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import * as pkg from "../lib/remote-browser-package.mjs";

const hash = (d) => createHash("sha256").update(d).digest("hex");
const run = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } }).trim();
const integ = "sha512-" + "A".repeat(86) + "==";
const lockPkg = (v, extra = {}) => ({ version: v, resolved: "https://registry.npmjs.org/x/-/x-" + v + ".tgz", integrity: integ, ...extra });
const GOOD_LOCK = { lockfileVersion: 3, packages: {
  "node_modules/@modelcontextprotocol/sdk": lockPkg("1.32.0", { dependencies: { zod: "^3" } }),
  "node_modules/zod": lockPkg("3.25.0"),
  "node_modules/playwright": lockPkg("1.63.0"),
} };
const FILES = {
  "src/v0/engine.mjs": "import { T } from './tools.mjs';\nimport fs from 'node:fs';\nexport const e = async () => (await import('./lazy.mjs')).L + T;\n",
  "src/v0/tools.mjs": "import { H } from '../live/host.mjs';\nexport const T = H;\n",
  "src/v0/lazy.mjs": "export const L = 1;\n",
  "src/live/host.mjs": "export const H = 2;\n",
  "src/v0/unrelated.mjs": "export const U = 1;\n",
};
function repo(t, { files = FILES, lock = GOOD_LOCK, sdkPin = "1.32.0" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rbp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  run(dir, "init", "-q");
  const all = { ...files, "package.json": JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": sdkPin } }), "package-lock.json": JSON.stringify(lock) };
  for (const [p, c] of Object.entries(all)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); }
  run(dir, "add", "-A"); run(dir, "commit", "-qm", "x");
  return { dir, rev: run(dir, "rev-parse", "HEAD") };
}
// The pinned production SHA cannot exist in a fixture, so tests inject it via a thin shim.
const plan = (dir, rev, over = {}) => {
  return pkg.planBrowserPackage({ sourceDir: dir, deny: {}, overlays: {}, revision: rev, ...over });
};

test("exports pinned constants", () => {
  assert.equal(pkg.BROWSER_SOURCE_REVISION, "7fdf2b9c4ba6038254f12a268ae957b07bd31d27");
  assert.equal(pkg.BROWSER_SDK.version, "1.32.0");
});

test("wrong HEAD vs pinned revision is rejected", (t) => {
  const { dir } = repo(t);
  assert.throws(() => pkg.planBrowserPackage({ sourceDir: dir }), /differs from pinned revision/);
  assert.throws(() => pkg.planBrowserPackage({ sourceDir: dir, revision: "not-a-sha" }), /full commit sha/);
});

test("closure follows static+lazy relative imports, sorted, excludes unrelated, deterministic", (t) => {
  const { dir, rev } = repo(t);
  const p = plan(dir, rev);
  assert.equal(p.ok, true);
  assert.deepEqual(p.files.map((f) => f.source), ["src/live/host.mjs", "src/v0/engine.mjs", "src/v0/lazy.mjs", "src/v0/tools.mjs"]);
  assert.equal(p.files[1].sha256, hash(FILES["src/v0/engine.mjs"]));
  assert.deepEqual(p.dependencies.packages.map((d) => d.path), ["node_modules/@modelcontextprotocol/sdk", "node_modules/zod"]);
  assert.equal(plan(dir, rev).planSha256, p.planSha256);
});

test("repo-local fsmonitor cannot execute and alternate object stores are rejected", t => {
  const { dir, rev } = repo(t);
  const marker = join(dir, ".git/fsmonitor-ran");
  run(dir, "config", "core.fsmonitor", "sh -c 'touch " + marker + "'");
  assert.equal(plan(dir, rev).ok, true);
  assert.equal(existsSync(marker), false);
  for (const name of ["alternates", "http-alternates"]) {
    const path = join(dir, ".git/objects/info", name);
    writeFileSync(path, "/not-an-approved-object-store\n");
    assert.throws(() => plan(dir, rev), /alternate object stores/);
    rmSync(path);
  }
});

test("denied module in closure is a blocker and blocks staging", async (t) => {
  const files = { ...FILES, "src/v0/tools.mjs": "import './jev.mjs';\n", "src/v0/jev.mjs": "export const J = 1;\n" };
  const { dir, rev } = repo(t, { files });
  const p = plan(dir, rev, { deny: { "src/v0/jev.mjs": "Jev wrapper" } });
  assert.equal(p.ok, false);
  assert.match(p.blockers[0].reason, /Jev/);
  await assert.rejects(pkg.stageBrowserSource({ plan: p }), /plan has blockers/);
  assert.ok(Object.keys(pkg.DEFAULT_DENY).includes("src/v0/jev.mjs"));
});

test("dirty or drifted selected bytes are rejected", (t) => {
  const { dir, rev } = repo(t);
  writeFileSync(join(dir, "src/v0/lazy.mjs"), "export const L = 9;\n");
  assert.throws(() => plan(dir, rev), /drift from git blob/);
});

test("closure escaping src/v0|src/live, symlinks and bare imports fail closed", (t) => {
  let r = repo(t, { files: { ...FILES, "src/v0/tools.mjs": "import '../../package.json.mjs';\n" } });
  assert.throws(() => plan(r.dir, r.rev), /escapes src/);
  r = repo(t, { files: { ...FILES, "src/v0/tools.mjs": "import 'left-pad';\nimport('./' + x);\n" } });
  const p = plan(r.dir, r.rev);
  assert.equal(p.ok, false);
  assert.ok(p.blockers.some((b) => b.path === "left-pad"));
  assert.ok(p.blockers.some((b) => /dynamic/.test(b.reason)));
  const dir = mkdtempSync(join(tmpdir(), "rbp-sym-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  run(dir, "init", "-q"); mkdirSync(join(dir, "src/v0"), { recursive: true });
  writeFileSync(join(dir, "real.mjs"), "export const R=1;\n"); symlinkSync("../../real.mjs", join(dir, "src/v0/engine.mjs"));
  writeFileSync(join(dir, "src/v0/tools.mjs"), "\n"); writeFileSync(join(dir, "package.json"), "{}"); writeFileSync(join(dir, "package-lock.json"), "{}");
  run(dir, "add", "-A"); run(dir, "commit", "-qm", "s");
  assert.throws(() => plan(dir, run(dir, "rev-parse", "HEAD")), /symlink/);
});

test("lock closure rejects unpinned SDK, missing integrity, git/non-registry, install scripts", (t) => {
  const bad = (mut) => { const l = structuredClone(GOOD_LOCK); mut(l.packages); const r = repo(t, { lock: l }); return plan(r.dir, r.rev); };
  assert.equal(bad((p) => { p["node_modules/zod"].integrity = undefined; }).ok, false);
  assert.equal(bad((p) => { p["node_modules/zod"].resolved = "git+ssh://x/y.git"; }).ok, false);
  assert.equal(bad((p) => { p["node_modules/zod"].hasInstallScript = true; }).ok, false);
  assert.equal(bad((p) => { p["node_modules/@modelcontextprotocol/sdk"].version = "1.33.0"; }).ok, false);
  assert.equal(bad((p) => { delete p["node_modules/zod"]; }).ok, false);
  const r = repo(t, { sdkPin: "^1.32.0" });
  assert.equal(plan(r.dir, r.rev).ok, false);
});

test("byte and file limits are enforced", (t) => {
  const { dir, rev } = repo(t);
  assert.throws(() => plan(dir, rev, { limits: { ...pkg.DEFAULT_LIMITS, maxBytes: 10 } }), /byte limit/);
  assert.throws(() => plan(dir, rev, { limits: { ...pkg.DEFAULT_LIMITS, maxFiles: 2 } }), /file limit/);
});

test("runtime attestation requires Linux node/Chrome/dependency digests; Darwin rejected", () => {
  const good = { platform: "linux-x64", node: "22.11.0", chrome: { platform: "linux-x64", version: "126.0.6478.126", sha256: "e".repeat(64) }, dependenciesArtifactSha256: "f".repeat(64), dependenciesLockSha256: "1".repeat(64) };
  assert.equal(pkg.validateRuntimeAttestation(good), true);
  assert.equal(pkg.validateRuntimeAttestation({ ...good, platform: "darwin-arm64" }), false);
  assert.equal(pkg.validateRuntimeAttestation({ ...good, chrome: { ...good.chrome, platform: "darwin-arm64" } }), false);
  assert.equal(pkg.validateRuntimeAttestation({ ...good, node: "18.0.0" }), false);
  assert.equal(pkg.validateRuntimeAttestation(undefined), false);
});

test("source-only staging reports not ready/not executable and stages exactly the closure", async (t) => {
  const { dir, rev } = repo(t);
  const p = plan(dir, rev);
  const identity = { forkVersion: "1.4.0", forkRevision: "a".repeat(40), myPiVersion: "0.1.0", myPiRevision: "b".repeat(40), profileSha256: "c".repeat(64) };
  const out = mkdtempSync(join(tmpdir(), "rbp-out-")); t.after(() => rmSync(out, { recursive: true, force: true }));
  const destination = join(out, "stage");
  const scanFile = async (path) => ({ sha256: hash(readFileSync(path)), ok: true, findings: 0 });
  const base = { plan: p, sourceDir: dir, identity, platform: "linux-x64", artifactSha256: "d".repeat(64), scanFile };
  const proof = await pkg.stageBrowserSource({ ...base, destination });
  assert.equal(proof.sourceOnly, true); assert.equal(proof.dependencyReady, false); assert.equal(proof.runtimeReady, false); assert.equal(proof.executable, false);
  assert.equal(proof.files.length, 4);
  assert.ok(existsSync(join(destination, "browser-harness/src/v0/engine.mjs")));
  assert.equal(existsSync(join(destination, "browser-harness/src/v0/unrelated.mjs")), false);
  assert.equal(existsSync(join(destination, "browser-harness/node_modules")), false);
  // Even with full attestation, source-only staging never claims an executable package.
  const att = { platform: "linux-x64", node: "22.11.0", chrome: { platform: "linux-x64", version: "126.0.6478.126", sha256: "e".repeat(64) }, dependenciesArtifactSha256: "f".repeat(64), dependenciesLockSha256: p.dependencies.lockSha256 };
  const proof2 = await pkg.stageBrowserSource({ ...base, destination: join(out, "stage2"), attestation: att });
  assert.equal(proof2.runtimeReady, true); assert.equal(proof2.dependencyReady, true); assert.equal(proof2.executable, false);
});

test("working-tree drift after planning fails staging and removes the stage", async (t) => {
  const { dir, rev } = repo(t);
  const p = plan(dir, rev);
  writeFileSync(join(dir, "src/v0/lazy.mjs"), "export const L = 2;\n");
  const identity = { forkVersion: "1.4.0", forkRevision: "a".repeat(40), myPiVersion: "0.1.0", myPiRevision: "b".repeat(40), profileSha256: "c".repeat(64) };
  const out = mkdtempSync(join(tmpdir(), "rbp-out-")); t.after(() => rmSync(out, { recursive: true, force: true }));
  await assert.rejects(pkg.stageBrowserSource({ plan: p, sourceDir: dir, identity, platform: "linux-x64", artifactSha256: "d".repeat(64), destination: join(out, "s"), scanFile: async (x) => ({ sha256: hash(readFileSync(x)), ok: true, findings: 0 }) }), /source (type\/size|digest) changed/);
  assert.equal(existsSync(join(out, "s")), false);
});

test("minimal v3 lock preserves pins and drops unrelated packages", (t) => {
  const { dir, rev } = repo(t);
  const files = pkg.minimalDependencyFiles(plan(dir, rev));
  const lock = JSON.parse(files["package-lock.json"]);
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(Object.keys(lock.packages), ["", "node_modules/@modelcontextprotocol/sdk", "node_modules/zod"]);
  assert.deepEqual(lock.packages["node_modules/zod"], GOOD_LOCK.packages["node_modules/zod"]);
  assert.deepEqual(JSON.parse(files["package.json"]).dependencies, { "@modelcontextprotocol/sdk": "1.32.0" });
  assert.doesNotMatch(files[".npmrc"], /auth|token/i);
  assert.equal(files.digests["package-lock.json"], hash(files["package-lock.json"]));
});

test("optionalDependencies in the closure fail instead of being stripped", (t) => {
  const l = structuredClone(GOOD_LOCK);
  l.packages["node_modules/zod"].optionalDependencies = { fsevents: "2.0.0" };
  const { dir, rev } = repo(t, { lock: l });
  const p = plan(dir, rev);
  assert.equal(p.ok, false);
  assert.ok(p.blockers.some((b) => /optionalDependencies/.test(b.reason)));
  assert.throws(() => pkg.minimalDependencyFiles(p), /blockers/);
});

test("lock rejects git/file/workspace/dev/v2 and platform mismatches", (t) => {
  const bad = (mut, lv = 3) => { const l = structuredClone(GOOD_LOCK); l.lockfileVersion = lv; mut(l.packages); const r = repo(t, { lock: l }); return plan(r.dir, r.rev); };
  assert.equal(bad((p) => { p["node_modules/zod"].resolved = "file:../zod"; }).ok, false);
  assert.equal(bad((p) => { p["node_modules/zod"].link = true; }).ok, false);
  assert.equal(bad((p) => { p["node_modules/zod"].dev = true; }).ok, false);
  assert.equal(bad(() => {}, 2).ok, false);
  const r = repo(t, { lock: (() => { const l = structuredClone(GOOD_LOCK); l.packages["node_modules/zod"].os = ["darwin"]; return l; })() });
  const p = plan(r.dir, r.rev);
  assert.deepEqual(pkg.lockPlatformMismatches(p, "linux-x64"), ["node_modules/zod"]);
  const out = mkdtempSync(join(tmpdir(), "rbp-dep-")); t.after(() => rmSync(out, { recursive: true, force: true }));
  assert.throws(() => pkg.writeDependencyStage({ plan: p, destination: join(out, "d"), platform: "linux-x64" }), /exclude target platform/);
});

test("dependency stage is new/private; npm ci plan has a scrubbed env and runs nothing", (t) => {
  const { dir, rev } = repo(t);
  const p = plan(dir, rev);
  const out = mkdtempSync(join(tmpdir(), "rbp-dep-")); t.after(() => rmSync(out, { recursive: true, force: true }));
  const destination = join(out, "deps");
  const w = pkg.writeDependencyStage({ plan: p, destination, platform: "linux-arm64" });
  assert.equal(w.installed, false);
  assert.equal(readFileSync(join(destination, "package-lock.json"), "utf8"), pkg.minimalDependencyFiles(p)["package-lock.json"]);
  assert.throws(() => pkg.writeDependencyStage({ plan: p, destination, platform: "linux-arm64" }));
  assert.ok(existsSync(join(destination, "package-lock.json")));
  const c = pkg.npmCiPlan({ directory: destination, platform: "linux-arm64" });
  assert.deepEqual(c.argv.slice(0, 3), ["ci", "--ignore-scripts", "--omit=dev"]);
  assert.equal(c.inheritEnv, false);
  assert.equal(c.env.npm_config_cpu, "arm64");
  assert.equal(c.env.npm_config_globalconfig, "/dev/null");
  assert.ok(!Object.keys(c.env).some((k) => /token|auth|npm_token|HOME_REAL/i.test(k)));
  assert.throws(() => pkg.npmCiPlan({ directory: destination, platform: "darwin-arm64" }), /unsupported/);
});

test("scanner ignores strings, comments, templates and regexes; rejects require and dynamic import", (t) => {
  const tricky = [
    "// import './nope.mjs'", "/* import('./nope2.mjs') */",
    "const a = 'import (x) from \"./nope3.mjs\"';", "const b = `import('./nope4.mjs') ${1 + 1}`;",
    "const c = /import\\('x'\\)/.test(a) ? 1 : 2; const o = { import: 1 }; const d = o.import;",
    "import { H } from \"../live/host.mjs\";", "export { L } from './lazy.mjs';",
  ].join("\n");
  let r = repo(t, { files: { ...FILES, "src/v0/tools.mjs": tricky } });
  assert.deepEqual(plan(r.dir, r.rev).files.map((f) => f.source), ["src/live/host.mjs", "src/v0/engine.mjs", "src/v0/lazy.mjs", "src/v0/tools.mjs"]);
  for (const [code, re] of [["require('fs');", /require/], ["import(x);", /dynamic/], ["const m = import('./' + n);", /dynamic/], ["import('./a\\x.mjs');", /unresolvable/], ["const a = 1;\nconst z = }/ 2;", /ambiguous|syntax/], ["const s = 'oops\n';", /string/]]) {
    r = repo(t, { files: { ...FILES, "src/v0/tools.mjs": code } });
    const p = plan(r.dir, r.rev);
    assert.equal(p.ok, false, code);
    assert.ok(p.blockers.some((b) => re.test(b.reason)), code);
  }
});

const OVERLAY_FILES = {
  ...FILES,
  "src/v0/tools.mjs": "import { runJev, jevConfig } from './jev.mjs';\nexport const T = jevConfig;\n",
  "src/v0/engine.mjs": "import './tools.mjs';\nimport { importEnabled } from './session-import.mjs';\nimport { IMPORTED } from './imported-profile.mjs';\nimport * as r from './real-import.mjs';\nexport const e = 1;\n",
  "src/v0/jev.mjs": "export const secret = process.env.TYPESAFE_API_KEY; export const runJev = 1; export const jevConfig = () => fetch('x');\n",
  "src/v0/session-import.mjs": "import { readFileSync } from 'node:fs'; export const importEnabled = () => true; export const x = readFileSync('/etc/passwd');\n",
  "src/v0/real-import.mjs": "import { isPublicSuffix } from './public-suffix.mjs';\nexport const parseDomains = 1;\n",
  "src/v0/public-suffix.mjs": "export const isPublicSuffix = 1;\n",
  "src/v0/imported-profile.mjs": "export const IMPORTED = 'imported'; export const k = process.env.HOME;\n",
};

test("overlays replace credential modules, record provenance, and drop their imports from the closure", (t) => {
  const { dir, rev } = repo(t, { files: OVERLAY_FILES });
  const p = pkg.planBrowserPackage({ sourceDir: dir, revision: rev });
  assert.equal(p.ok, true);
  assert.equal(p.files.some((f) => f.source === "src/v0/public-suffix.mjs"), false);
  assert.deepEqual(p.overlays.map((o) => o.path), Object.keys(pkg.DEFAULT_OVERLAYS).sort());
  for (const o of p.overlays) {
    assert.equal(o.baseSha256, hash(OVERLAY_FILES[o.path]));
    assert.equal(o.overlaySha256, hash(pkg.DEFAULT_OVERLAYS[o.path].text));
    assert.equal(p.files.find((f) => f.source === o.path).sha256, o.overlaySha256);
  }
  const other = repo(t, { files: { ...OVERLAY_FILES, "src/v0/jev.mjs": "export const different = 1;\n" } });
  assert.notEqual(pkg.planBrowserPackage({ sourceDir: other.dir, revision: other.rev }).planSha256, p.planSha256);
});

test("overlay base drift or a dirty tree still rejects", (t) => {
  const { dir, rev } = repo(t, { files: OVERLAY_FILES });
  writeFileSync(join(dir, "src/v0/jev.mjs"), "export const runJev = 2;\n");
  assert.throws(() => pkg.planBrowserPackage({ sourceDir: dir, revision: rev }), /drift from git blob/);
});

test("overlay stubs are inert, export the engine names, and unsafe overlays are refused", (t) => {
  const names = (k) => [...pkg.DEFAULT_OVERLAYS[k].text.matchAll(/export const (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(names("src/v0/jev.mjs"), ["runJev", "jevConfig"]);
  assert.deepEqual(names("src/v0/session-import.mjs").sort(), ["applyImport", "copyProfile", "deniedRoots", "importEnabled", "importSummary", "loadImports", "parsePasswords", "seedSessionStorage", "shredFile", "toCdpCookie"]);
  assert.deepEqual(names("src/v0/real-import.mjs").sort(), ["filterCookies", "filterPasswords", "fromChromeCookie", "hostAllowed", "parseDomains", "realSummary"]);
  assert.deepEqual(names("src/v0/imported-profile.mjs"), ["IMPORTED", "prepareImportedDir", "hardenTree"]);
  for (const o of Object.values(pkg.DEFAULT_OVERLAYS)) assert.doesNotMatch(o.text, /process|fetch|import\s|require|readFile/);
  const { dir, rev } = repo(t, { files: OVERLAY_FILES });
  assert.throws(() => pkg.planBrowserPackage({ sourceDir: dir, revision: rev, overlays: { "src/v0/jev.mjs": { recipe: "x", text: "export const k = process.env.KEY;" } } }), /unsafe overlay/);
});

test("staging writes overlay bytes (not originals) through the scanner and rejects a tampered plan", async (t) => {
  const { dir, rev } = repo(t, { files: OVERLAY_FILES });
  const p = pkg.planBrowserPackage({ sourceDir: dir, revision: rev });
  const identity = { forkVersion: "1.4.0", forkRevision: "a".repeat(40), myPiVersion: "0.1.0", myPiRevision: "b".repeat(40), profileSha256: "c".repeat(64) };
  const out = mkdtempSync(join(tmpdir(), "rbp-out-")); t.after(() => rmSync(out, { recursive: true, force: true }));
  const scanned = [];
  const scanFile = async (path) => { scanned.push(path); return { sha256: hash(readFileSync(path)), ok: true, findings: 0 }; };
  const base = { sourceDir: dir, identity, platform: "linux-x64", artifactSha256: "d".repeat(64), scanFile };
  const proof = await pkg.stageBrowserSource({ ...base, plan: p, destination: join(out, "s") });
  const staged = readFileSync(join(out, "s/browser-harness/src/v0/jev.mjs"), "utf8");
  assert.equal(staged, pkg.DEFAULT_OVERLAYS["src/v0/jev.mjs"].text);
  assert.doesNotMatch(staged, /TYPESAFE|fetch/);
  assert.equal(scanned.length, p.files.length);
  assert.equal(proof.overlays.length, 4);
  const bad = structuredClone(p);
  bad.files.find((f) => f.source === "src/v0/jev.mjs").sha256 = "0".repeat(64);
  await assert.rejects(pkg.stageBrowserSource({ ...base, plan: bad, destination: join(out, "s2") }), /overlay does not match/);
  assert.equal(existsSync(join(out, "s2")), false);
});

const REAL = "/Users/luke/Projects/personal/browser-harness";
test("actual pinned browser source plans ok with guarded overlays and the exact 94-package closure", { skip: !existsSync(REAL) || execFileSync("git", ["-C", REAL, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== pkg.BROWSER_SOURCE_REVISION }, () => {
  const p = pkg.planBrowserPackage({ sourceDir: REAL });
  assert.equal(p.ok, true, JSON.stringify(p.blockers));
  assert.equal(p.dependencies.packages.length, 94);
  assert.deepEqual(p.bareImports, []);
  assert.equal(p.overlays.length, 4);
  assert.deepEqual(pkg.lockPlatformMismatches(p, "linux-x64"), []);
});
