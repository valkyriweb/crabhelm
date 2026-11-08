import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { validateRelativePath } from "./remote-child-contract.mjs";
import { stageRemoteChildFiles } from "./remote-child-files.mjs";

export const BROWSER_SOURCE_REVISION = "7fdf2b9c4ba6038254f12a268ae957b07bd31d27";
export const BROWSER_SDK = Object.freeze({ name: "@modelcontextprotocol/sdk", version: "1.32.0" });
export const DEFAULT_ENTRYPOINTS = Object.freeze(["src/v0/engine.mjs", "src/v0/tools.mjs"]);
// Modules the donor must never receive. Reaching one is a blocker, not a silent skip:
// the parent must supply a patched entrypoint or an explicit reviewed override.
export const DEFAULT_DENY = Object.freeze({
  "src/v0/jev.mjs": "Jev wrapper (API-key/ClawRouter client) is excluded",
  "src/v0/session-import.mjs": "session/cookie/password import reads auth stores",
  "src/v0/real-import.mjs": "real-login import reads auth stores",
  "src/v0/imported-profile.mjs": "imported-profile holds persistent login state",
});
export const DEFAULT_LIMITS = Object.freeze({ maxFiles: 64, maxBytes: 2 * 1024 * 1024, maxFileBytes: 512 * 1024, maxDependencies: 200 });

// Reviewed, static, self-contained donor stubs. They replace credential-bearing modules; the originals are
// never copied. Each stub only throws "unavailable" or returns an inert value. Names mirror the pinned
// engine.mjs/chrome.mjs imports (inspected at the pinned revision).
const unavailable = (name) => `export const ${name} = () => { throw new Error("unavailable in donor: ${name}"); };`;
const stubLines = (names) => names.map(unavailable).join("\n");
export const DEFAULT_OVERLAYS = Object.freeze({
  "src/v0/jev.mjs": { recipe: "donor-stub-jev-v1", text:
    'export const runJev = async () => { throw new Error("unavailable in donor: runJev"); };\nexport const jevConfig = () => ({ key: undefined });\n' },
  "src/v0/session-import.mjs": { recipe: "donor-stub-session-import-v1", text:
    stubLines(["loadImports", "copyProfile", "applyImport", "seedSessionStorage", "importSummary", "parsePasswords", "toCdpCookie", "shredFile"]) +
    "\nexport const importEnabled = () => false;\nexport const deniedRoots = () => [];\n" },
  "src/v0/real-import.mjs": { recipe: "donor-stub-real-import-v1", text:
    stubLines(["parseDomains", "hostAllowed", "filterCookies", "filterPasswords", "fromChromeCookie", "realSummary"]) + "\n" },
  "src/v0/imported-profile.mjs": { recipe: "donor-stub-imported-profile-v1", text:
    "export const IMPORTED = 'imported';\n" + stubLines(["prepareImportedDir", "hardenTree"]) + "\n" },
});
const overlaySha = (o) => sha256(o.text);
// A stub must be self-contained and inert: no imports, process access, I/O or network tokens.
function assertOverlaySafe(path, o) {
  if (importsOf(o.text, path, []).length || /\b(?:process|fetch|require|import|globalThis|eval|Function|child_process|readFile|writeFile)\b/.test(o.text) || o.text.length > 4096) fail("unsafe overlay: " + path);
}
const SOURCE_DIRS = ["src/v0/", "src/live/"];
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const fail = (reason) => { throw new Error("remote-browser-package: " + reason); };

// Fixed argv, scrubbed env: no user git config, hooks, pagers or alternates can alter reads.
function git(root, args, { binary = false } = {}) {
  const out = execFileSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    maxBuffer: 16 * 1024 * 1024, timeout: 10000, stdio: ["ignore", "pipe", "ignore"],
  });
  return binary ? out : out.toString("utf8");
}

function readPinnedBlob(root, revision, path) {
  let listing;
  try { listing = git(root, ["ls-tree", "-z", revision, "--", path]); } catch { fail("path not in pinned revision: " + path); }
  const m = /^(\d+) (\w+) ([0-9a-f]{40})\t(.+)\0$/s.exec(listing);
  if (!m || m[4] !== path) fail("path not in pinned revision: " + path);
  if (m[1] !== "100644" && m[1] !== "100755") fail("selected path is not a regular git blob (symlink/submodule): " + path);
  return { mode: m[1], blob: m[3], bytes: git(root, ["cat-file", "blob", m[3]], { binary: true }) };
}

const REGEX_KW = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const unsupported = (why) => { throw new Error("unsupported syntax: " + why); };
// Minimal lexer: strips comments, records string literals, scans template substitutions, skips regex
// literals. Ambiguous or malformed input throws so the caller fails closed (it is not a JS parser).
function tokenize(s) {
  const out = [];
  const n = s.length;
  let i = s.startsWith("#!") ? s.indexOf("\n") : 0;
  if (i < 0) i = n;
  const scan = (inTpl) => {
    let depth = 0;
    while (i < n) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "/" && s[i + 1] === "/") { while (i < n && s[i] !== "\n") i++; continue; }
      if (c === "/" && s[i + 1] === "*") { const e = s.indexOf("*/", i + 2); if (e < 0) unsupported("unterminated comment"); i = e + 2; continue; }
      if (c === "'" || c === '"') {
        let j = i + 1, esc = false;
        while (j < n && s[j] !== c) { if (s[j] === "\n") unsupported("newline in string"); if (s[j] === "\\") { esc = true; j++; } j++; }
        if (j >= n) unsupported("unterminated string");
        out.push({ t: "str", v: s.slice(i + 1, j), esc }); i = j + 1; continue;
      }
      if (c === "`") {
        i++;
        for (;;) {
          if (i >= n) unsupported("unterminated template");
          if (s[i] === "\\") { i += 2; continue; }
          if (s[i] === "`") { i++; break; }
          if (s[i] === "$" && s[i + 1] === "{") { i += 2; scan(true); continue; }
          i++;
        }
        out.push({ t: "tpl", v: "" }); continue;
      }
      if (c === "/") {
        const p = out.at(-1);
        const div = p && (p.t === "str" || p.t === "tpl" || (p.t === "id" && !REGEX_KW.has(p.v)) || p.v === ")" || p.v === "]");
        if (p?.v === "}") unsupported("ambiguous slash after brace");
        if (div) { out.push({ t: "p", v: c }); i++; continue; }
        let j = i + 1, cls = false;
        for (; j < n; j++) {
          if (s[j] === "\n") unsupported("newline in regex");
          if (s[j] === "\\") { j++; continue; }
          if (s[j] === "[") cls = true; else if (s[j] === "]") cls = false; else if (s[j] === "/" && !cls) break;
        }
        if (j >= n) unsupported("unterminated regex");
        i = j + 1; while (/[a-z]/i.test(s[i] ?? "")) i++;
        out.push({ t: "tpl", v: "" }); continue;
      }
      if (/[\w$\u0080-\uffff]/.test(c)) { let j = i + 1; while (j < n && /[\w$\u0080-\uffff]/.test(s[j])) j++; out.push({ t: "id", v: s.slice(i, j) }); i = j; continue; }
      if (c === "{") depth++;
      if (c === "}") { if (depth === 0 && inTpl) { i++; return; } depth--; }
      out.push({ t: "p", v: c }); i++;
    }
    if (inTpl) unsupported("unterminated template substitution");
  };
  scan(false);
  return out;
}

function importsOf(source, path, blockers) {
  let tok;
  try { tok = tokenize(source); } catch (e) { blockers.push({ path, reason: e.message }); return []; }
  const specs = [];
  const add = (t) => { if (t.esc || !t.v) blockers.push({ path, reason: "unresolvable import specifier" }); else specs.push(t.v); };
  const is = (t, type, v) => t?.t === type && (v === undefined || t.v === v);
  const fromAfter = (j, stop) => { for (; j < tok.length && !is(tok[j], "p", stop); j++) if (is(tok[j], "id", "from") && is(tok[j + 1], "str")) return tok[j + 1]; return undefined; };
  for (let k = 0; k < tok.length; k++) {
    const t = tok[k];
    if (t.t !== "id" || is(tok[k - 1], "p", ".")) continue;
    const next = tok[k + 1];
    if (is(next, "p", ":")) continue; // object key such as `import: paths` (a keyword cannot start `import:` otherwise)
    if (t.v === "require" || t.v === "createRequire") blockers.push({ path, reason: t.v + " is not statically resolvable" });
    else if (t.v === "import") {
      if (is(next, "str")) add(next);
      else if (is(next, "p", "(")) { if (is(tok[k + 2], "str") && is(tok[k + 3], "p", ")")) add(tok[k + 2]); else blockers.push({ path, reason: "dynamic import is not statically resolvable" }); }
      else if (!is(next, "p", ".")) { const f = fromAfter(k + 1, ";"); if (f) add(f); else blockers.push({ path, reason: "unsupported import form" }); }
    } else if (t.v === "export" && (is(next, "p", "*") || is(next, "p", "{"))) {
      let j = k + 1;
      if (next.v === "{") { while (j < tok.length && !is(tok[j], "p", "}")) j++; }
      if (is(tok[j + 1], "id", "from") && is(tok[j + 2], "str")) add(tok[j + 2]);
      else if (next.v === "*") { const f = fromAfter(k + 1, ";"); if (f) add(f); else blockers.push({ path, reason: "unsupported export form" }); }
    }
  }
  return specs;
}

function walkLock(lock, rootPkgPath, blockers) {
  const pkgs = lock.packages ?? {};
  const seen = new Map();
  const queue = [rootPkgPath];
  const find = (from, name) => {
    let base = from;
    for (;;) {
      const cand = base + "/node_modules/" + name;
      if (pkgs[cand]) return cand;
      const cut = base.lastIndexOf("/node_modules/");
      if (cut < 0) break;
      base = base.slice(0, cut);
    }
    return pkgs["node_modules/" + name] ? "node_modules/" + name : undefined;
  };
  while (queue.length) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    const p = pkgs[path];
    if (!p) { blockers.push({ path, reason: "lock entry missing" }); continue; }
    if (p.link) blockers.push({ path, reason: "link package in lock" });
    if (typeof p.version !== "string" || !/^\d+\.\d+\.\d+/.test(p.version)) blockers.push({ path, reason: "unpinned version" });
    if (typeof p.resolved !== "string" || !p.resolved.startsWith("https://registry.npmjs.org/")) blockers.push({ path, reason: "non-registry or missing resolved URL" });
    if (typeof p.integrity !== "string" || !/^sha512-[A-Za-z0-9+/=]+$/.test(p.integrity)) blockers.push({ path, reason: "missing sha512 integrity" });
    if (p.optionalDependencies && Object.keys(p.optionalDependencies).length) blockers.push({ path, reason: "optionalDependencies unsupported by minimal lock" });
    if (p.dev || p.inBundle || p.bundleDependencies) blockers.push({ path, reason: "dev/bundled package in production closure" });
    if (typeof p.resolved === "string" && /^(?:git|file|link|workspace|github|http:)/.test(p.resolved)) blockers.push({ path, reason: "git/file/workspace/http source" });
    if (p.hasInstallScript) blockers.push({ path, reason: "install script must be reviewed" });
    seen.set(path, { path, version: p.version, resolved: p.resolved, integrity: p.integrity, os: p.os ?? null, cpu: p.cpu ?? null, entry: p });
    const optionalPeers = p.peerDependenciesMeta ?? {};
    const names = [...Object.keys(p.dependencies ?? {}),
      ...Object.keys(p.peerDependencies ?? {}).filter((n) => !optionalPeers[n]?.optional)];
    for (const name of names) {
      const hit = find(path, name);
      if (!hit) blockers.push({ path, reason: "unresolved dependency " + name }); else queue.push(hit);
    }
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Pure planning: verifies the pinned checkout, computes the relative-import closure of the
 * entrypoints, and pins the SDK dependency closure from the pinned package-lock blob.
 * Never throws for policy blockers; returns { ok:false, blockers } so the caller can report.
 * `revision` defaults to the pinned constant; override exists for fixtures only.
 * Throws for structural faults (wrong revision, dirty/drifted bytes, escapes, over-limit).
 */
export function planBrowserPackage({ sourceDir, revision = BROWSER_SOURCE_REVISION, entrypoints = DEFAULT_ENTRYPOINTS, deny = DEFAULT_DENY, overlays = DEFAULT_OVERLAYS, limits = DEFAULT_LIMITS }) {
  if (typeof sourceDir !== "string" || !sourceDir) fail("sourceDir required");
  if (!/^[0-9a-f]{40}$/.test(revision)) fail("revision must be a full commit sha");
  const root = realpathSync(sourceDir);
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim();
  if (existsSync(join(common, "objects/info/alternates")) || existsSync(join(common, "objects/info/http-alternates"))) fail("alternate object stores are unsupported");
  if (git(root, ["rev-parse", "HEAD"]).trim() !== revision) fail("source HEAD differs from pinned revision");
  const blockers = [];
  const files = new Map();
  const overlayRecords = [];
  const bare = new Set();
  const todo = [...entrypoints];
  while (todo.length) {
    const path = validateRelativePath(todo.shift());
    if (files.has(path)) continue;
    if (!SOURCE_DIRS.some((d) => path.startsWith(d)) || !/\.mjs$/.test(path)) fail("closure escapes src/v0 and src/live: " + path);
    if (files.size >= limits.maxFiles) fail("closure exceeds file limit");
    const pinned = readPinnedBlob(root, revision, path);
    const abs = resolve(root, path);
    if (!abs.startsWith(root + sep)) fail("path escapes source root");
    for (let dir = dirname(abs); dir !== root; dir = dirname(dir)) if (lstatSync(dir).isSymbolicLink()) fail("symlinked ancestor: " + path);
    const st = lstatSync(abs);
    if (!st.isFile() || st.isSymbolicLink()) fail("selected path is not a regular file: " + path);
    if (pinned.bytes.length > limits.maxFileBytes) fail("file exceeds per-file limit: " + path);
    const working = readFileSync(abs);
    if (!working.equals(pinned.bytes)) fail("working bytes drift from git blob: " + path);
    if (git(root, ["status", "--porcelain", "--", path]).trim()) fail("selected path is not clean: " + path);
    // Original bytes were verified above (pinned blob, clean, no drift); an overlay then replaces them.
    const overlay = Object.hasOwn(overlays, path) ? overlays[path] : undefined;
    if (overlay) { assertOverlaySafe(path, overlay); overlayRecords.push({ path, recipe: overlay.recipe, baseSha256: sha256(pinned.bytes), baseGitBlob: pinned.blob, overlaySha256: overlaySha(overlay) }); }
    else if (deny[path]) blockers.push({ path, reason: deny[path] });
    const body = overlay ? Buffer.from(overlay.text) : pinned.bytes;
    files.set(path, { source: path, sha256: sha256(body), size: body.length, gitBlob: pinned.blob, executable: pinned.mode === "100755", origin: overlay ? "overlay" : "git" });
    for (const spec of importsOf(body.toString("utf8"), path, blockers)) {
      if (spec.startsWith("node:")) continue;
      if (spec.startsWith(".")) todo.push(posix.normalize(posix.join(posix.dirname(path), spec)));
      else bare.add(spec);
    }
  }
  const total = [...files.values()].reduce((s, f) => s + f.size, 0);
  if (total > limits.maxBytes) fail("closure exceeds byte limit");
  for (const spec of bare) if (spec !== BROWSER_SDK.name && !spec.startsWith(BROWSER_SDK.name + "/")) blockers.push({ path: spec, reason: "unexpected bare import outside pinned SDK" });

  const pkg = JSON.parse(readPinnedBlob(root, revision, "package.json").bytes.toString("utf8"));
  if (pkg.dependencies?.[BROWSER_SDK.name] !== BROWSER_SDK.version) blockers.push({ path: "package.json", reason: "SDK not pinned exactly to " + BROWSER_SDK.version });
  const lockBlob = readPinnedBlob(root, revision, "package-lock.json");
  const lock = JSON.parse(lockBlob.bytes.toString("utf8"));
  const sdkPath = "node_modules/" + BROWSER_SDK.name;
  if (lock.packages?.[sdkPath]?.version !== BROWSER_SDK.version) blockers.push({ path: sdkPath, reason: "lock SDK version mismatch" });
  if (lock.lockfileVersion !== 3) blockers.push({ path: "package-lock.json", reason: "lockfileVersion must be 3" });
  const dependencies = walkLock(lock, sdkPath, blockers);
  if (dependencies.length > limits.maxDependencies) fail("dependency closure exceeds limit");
  const sorted = [...files.values()].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));
  const lockSha256 = sha256(lockBlob.bytes);
  const body = { revision, files: sorted, overlays: overlayRecords.sort((a, b) => (a.path < b.path ? -1 : 1)), dependencies: { lockSha256, packages: dependencies.map(({ entry, ...rest }) => rest), entries: Object.fromEntries(dependencies.map((d) => [d.path, d.entry])), lockfileVersion: lock.lockfileVersion }, bareImports: [...bare].sort() };
  return { ok: blockers.length === 0, blockers, ...body, totalBytes: total, planSha256: remoteBrowserPlanSha256(body) };
}

/**
 * Digest of the plan body (revision, files, overlays, dependencies, bareImports; this key order).
 * Recomputes the existing `planSha256` bytes from a plan object, so a verifier can detect a plan whose
 * body was edited after planning. It does not cover `ok`, `blockers` or `totalBytes`; callers check those.
 */
export function remoteBrowserPlanSha256({ revision, files, overlays, dependencies, bareImports }) {
  return sha256(JSON.stringify({ revision, files, overlays, dependencies, bareImports }));
}

const NODE = /^(?:2[2-9]|[3-9]\d)\.\d+\.\d+$/;
/** Linux runtime attestation, always separate from source. Darwin/unknown never validates. */
export function validateRuntimeAttestation(a) {
  const ok = a && typeof a === "object" && ["linux-x64", "linux-arm64"].includes(a.platform) &&
    typeof a.node === "string" && NODE.test(a.node) &&
    a.chrome && typeof a.chrome === "object" && a.chrome.platform === a.platform &&
    typeof a.chrome.version === "string" && /^\d+\.\d+\.\d+\.\d+$/.test(a.chrome.version) &&
    /^[a-f0-9]{64}$/.test(a.chrome.sha256 ?? "") && /^[a-f0-9]{64}$/.test(a.dependenciesArtifactSha256 ?? "") &&
    /^[a-f0-9]{64}$/.test(a.dependenciesLockSha256 ?? "");
  return Boolean(ok);
}

/**
 * Stages source-only. Dependencies are never copied from this Mac. `dependencyReady` is true only
 * when a Linux-built dependency artifact digest is attested against the same lock; `executable`
 * additionally needs Linux node+Chrome attestation. Source staging alone reports both false.
 */
export async function stageBrowserSource({ plan, sourceDir, destination, scanFile, identity, platform, artifactSha256, attestation }) {
  if (!plan?.ok) fail("plan has blockers: " + (plan?.blockers ?? []).map((b) => b.path).join(", "));
  const files = plan.files.map((f) => ({ root: f.origin === "overlay" ? "overlay" : "browser", source: f.source, target: "browser-harness/" + f.source, sha256: f.sha256, size: f.size, kind: "workspace", executable: f.executable }));
  const runtime = { identity, platform, artifactSha256 };
  // Overlay bytes come from this module's reviewed constants (never from the plan), re-checked against the plan digests,
  // and are written to a separate private source root so the scanner sees the exact staged bytes.
  const overlayRoot = mkdtempSync(join(tmpdir(), "rbp-overlay-"));
  let proof;
  try {
    for (const f of plan.files.filter((x) => x.origin === "overlay")) {
      const o = DEFAULT_OVERLAYS[f.source];
      const rec = plan.overlays.find((r) => r.path === f.source);
      if (!o || !rec || rec.recipe !== o.recipe || overlaySha(o) !== f.sha256 || rec.overlaySha256 !== f.sha256) fail("overlay does not match reviewed recipe: " + f.source);
      assertOverlaySafe(f.source, o);
      mkdirSync(dirname(join(overlayRoot, f.source)), { recursive: true, mode: 0o700 });
      const fd = openSync(join(overlayRoot, f.source), "wx", 0o600);
      try { writeSync(fd, o.text); } finally { closeSync(fd); }
    }
    proof = await stageRemoteChildFiles({
      manifest: { version: 1, runtime, files, mcp: [] },
      expected: { identity, platform, artifactSha256, files: structuredClone(files), mcp: [] },
      roots: { browser: sourceDir, overlay: overlayRoot }, destination, scanFile,
    });
  } finally { rmSync(overlayRoot, { recursive: true, force: true }); }
  const runtimeReady = validateRuntimeAttestation(attestation) && attestation.platform === platform;
  const dependencyReady = runtimeReady && attestation.dependenciesLockSha256 === plan.dependencies.lockSha256;
  return { ...proof, overlays: plan.overlays, revision: plan.revision, planSha256: plan.planSha256, dependencyLockSha256: plan.dependencies.lockSha256,
    sourceOnly: true, dependencyReady, runtimeReady, executable: false };
}

const NPM_PLATFORM = { "linux-x64": { os: "linux", cpu: "x64" }, "linux-arm64": { os: "linux", cpu: "arm64" } };
const allowed = (list, value) => {
  if (!Array.isArray(list) || !list.length) return true;
  const neg = list.filter((x) => x.startsWith("!")).map((x) => x.slice(1));
  const pos = list.filter((x) => !x.startsWith("!"));
  return !neg.includes(value) && (!pos.length || pos.includes(value));
};
/** Packages whose os/cpu fields exclude the target (they would be skipped or fail on Linux). */
export function lockPlatformMismatches(plan, platform) {
  const t = NPM_PLATFORM[platform];
  if (!t) fail("unsupported target platform");
  return plan.dependencies.packages.filter((d) => !allowed(d.os, t.os) || !allowed(d.cpu, t.cpu)).map((d) => d.path);
}

/**
 * Minimal npm v3 manifest+lock: root pins only the SDK; every other entry is copied verbatim from the
 * pinned lock (resolved, integrity, version preserved). Entries with optionalDependencies are plan blockers,
 * so nothing is stripped or rewritten. Pure; no I/O.
 */
export function minimalDependencyFiles(plan) {
  if (!plan?.ok) fail("plan has blockers");
  const entries = {};
  for (const path of Object.keys(plan.dependencies.entries).sort()) {
    entries[path] = plan.dependencies.entries[path];
  }
  const name = "remote-browser-donor";
  const packageJson = JSON.stringify({ name, version: "0.0.0", private: true, type: "module", dependencies: { [BROWSER_SDK.name]: BROWSER_SDK.version } }, null, 2) + "\n";
  const lock = JSON.stringify({ name, version: "0.0.0", lockfileVersion: 3, requires: true,
    packages: { "": { name, version: "0.0.0", dependencies: { [BROWSER_SDK.name]: BROWSER_SDK.version } }, ...entries } }, null, 2) + "\n";
  const npmrc = "registry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\nupdate-notifier=false\n";
  return { "package.json": packageJson, "package-lock.json": lock, ".npmrc": npmrc,
    digests: { "package.json": sha256(packageJson), "package-lock.json": sha256(lock), ".npmrc": sha256(npmrc) } };
}

/** Writes the three files into a NEW private directory (never reuses one). Does not run npm. */
export function writeDependencyStage({ plan, destination, platform }) {
  if (typeof destination !== "string" || !isAbsolute(destination)) fail("destination must be absolute");
  const bad = lockPlatformMismatches(plan, platform);
  if (bad.length) fail("lock packages exclude target platform: " + bad.join(", "));
  const files = minimalDependencyFiles(plan);
  mkdirSync(destination, { mode: 0o700 });
  let done = false;
  try {
    for (const name of ["package.json", "package-lock.json", ".npmrc"]) {
      const fd = openSync(join(destination, name), "wx", 0o600);
      try { writeSync(fd, files[name]); } finally { closeSync(fd); }
    }
    done = true;
    return { directory: destination, digests: files.digests, platform, installed: false };
  } finally { if (!done) rmSync(destination, { recursive: true, force: true }); }
}

/**
 * Command plan for the caller to execute on the Linux build host. Replaces the environment entirely
 * (spawn with `env` set, `-i` semantics): no auth tokens, user/global npmrc or shared cache.
 */
export function npmCiPlan({ directory, platform, npm = "npm", path = "/usr/local/bin:/usr/bin:/bin" }) {
  const t = NPM_PLATFORM[platform];
  if (!t) fail("unsupported target platform");
  if (!isAbsolute(directory)) fail("directory must be absolute");
  return {
    cwd: directory, command: npm,
    argv: ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--no-update-notifier", "--registry=https://registry.npmjs.org/"],
    inheritEnv: false,
    env: { PATH: path, HOME: join(directory, ".home"), TMPDIR: join(directory, ".tmp"),
      npm_config_userconfig: join(directory, ".npmrc"), npm_config_globalconfig: "/dev/null",
      npm_config_cache: join(directory, ".npm-cache"), npm_config_os: t.os, npm_config_cpu: t.cpu, npm_config_ignore_scripts: "true" },
    mustCreate: [join(directory, ".home"), join(directory, ".tmp")],
    afterInstall: "tar/digest node_modules on the Linux host, then attest dependenciesArtifactSha256 and dependenciesLockSha256 === plan.dependencies.lockSha256",
  };
}
