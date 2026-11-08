import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BROWSER_SDK, BROWSER_SOURCE_REVISION, DEFAULT_DENY, DEFAULT_LIMITS, DEFAULT_OVERLAYS,
  lockPlatformMismatches, minimalDependencyFiles, remoteBrowserPlanSha256, validateRuntimeAttestation,
} from "./remote-browser-package.mjs";
import { BROWSER_BUNDLE_LIMITS, verifyRemoteBrowserBundle } from "./remote-browser-bundle.mjs";
import { validateRelativePath } from "./remote-child-contract.mjs";

/*
 * Host-side closure verification for a staged Linux donor bundle. Pure planning math plus bounded local
 * reads. It never imports, executes or installs anything from the bundle.
 *
 * Meanings kept distinct:
 *  - dependenciesArtifactSha256: SHA-256 of the actual dependency tar.gz (unchanged; not a tree hash).
 *  - dependencyInventorySha256: digest of the exact extracted node_modules file list (path, size, sha256),
 *    defined here. It is only meaningful when the inventory came from a trusted host derivation.
 * Package versions and lock SRI values do NOT prove extracted bytes. Exact dependency bytes are proven only
 * against a caller-supplied trusted inventory that the caller derived independently from the verified archive.
 * Open: Chrome auxiliary/native library closure; same-UID immutability after verification.
 */

const fail = (reason) => { throw new Error("remote-browser-closure: " + reason); };
const isDigest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const isSize = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const exactKeys = (value, keys) => isPlain(value) && Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));

export const BROWSER_CLOSURE_LIMITS = Object.freeze({ packageJsonBytes: 256 * 1024, hiddenLockfileBytes: 2 * 1024 * 1024 });
export const ROOT_FILES = Object.freeze(["package.json", "package-lock.json", ".npmrc"]);
// `npm ci` writes this hidden lockfile into node_modules and the Linux artifact recipe keeps it. It is the
// ONLY node_modules-root dot entry accepted, and only when the trusted inventory binds its exact bytes. If
// present, its v3 package membership and versions must equal the plan. It is never mutated or stripped.
export const HIDDEN_LOCKFILE = "node_modules/.package-lock.json";
const SDK_PATH = "node_modules/" + BROWSER_SDK.name;
const SOURCE_DIRS = ["src/v0/", "src/live/"];
const SCOPE = /^@[a-z0-9][a-z0-9~._-]*$/i;
const NAME = /^[a-z0-9][a-z0-9~._-]*$/i;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

const validPackageName = (name) => {
  if (typeof name !== "string") return false;
  const parts = name.split("/");
  return parts.length === 1 ? NAME.test(parts[0]) : parts.length === 2 && SCOPE.test(parts[0]) && NAME.test(parts[1]);
};

/** Splits "node_modules/a/node_modules/@s/b" into package names, or throws. Last name is the path's package. */
function packageNamesOf(path) {
  const parts = validateRelativePath(path).split("/");
  const names = [];
  for (let i = 0; i < parts.length;) {
    if (parts[i] !== "node_modules") fail("planned package path is not a node_modules path: " + path);
    const first = parts[i + 1];
    if (typeof first !== "string") fail("planned package path is incomplete: " + path);
    if (first.startsWith("@")) {
      const second = parts[i + 2];
      if (!SCOPE.test(first) || typeof second !== "string" || !NAME.test(second)) fail("invalid planned package path: " + path);
      names.push(first + "/" + second); i += 3;
    } else {
      if (!NAME.test(first)) fail("invalid planned package path: " + path);
      names.push(first); i += 2;
    }
  }
  return names;
}

/**
 * Distinct digest of an extracted dependency tree listing. Canonical: sorted by path, domain-separated.
 * Not an archive hash and not derived from package versions.
 */
export function remoteBrowserDependencyInventorySha256(files) {
  if (!Array.isArray(files)) fail("dependency inventory files must be an array");
  const rows = files.map((f) => {
    if (!exactKeys(f, ["path", "size", "sha256"]) || !isSize(f.size) || !isDigest(f.sha256)) fail("invalid dependency inventory entry");
    return [validateRelativePath(f.path), f.size, f.sha256];
  }).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let i = 1; i < rows.length; i++) if (rows[i][0] === rows[i - 1][0]) fail("duplicate dependency inventory path");
  return sha256("remote-browser-dependency-inventory-v1\n" + JSON.stringify(rows));
}

function checkOverlays(plan) {
  const overlayFiles = plan.files.filter((f) => f.origin === "overlay");
  if (!Array.isArray(plan.overlays) || plan.overlays.length !== overlayFiles.length) fail("overlay records do not match overlay files");
  const seen = new Set();
  for (const f of plan.files) {
    const reviewed = Object.hasOwn(DEFAULT_OVERLAYS, f.source);
    if ((reviewed || Object.hasOwn(DEFAULT_DENY, f.source)) && f.origin !== "overlay") fail("denied or overlaid module carries original bytes: " + f.source);
    if (f.origin === "overlay" && !reviewed) fail("overlay is not a reviewed recipe: " + f.source);
  }
  for (const f of overlayFiles) {
    const reviewed = DEFAULT_OVERLAYS[f.source];
    const rec = plan.overlays.find((r) => r?.path === f.source);
    if (!rec || seen.has(f.source)) fail("overlay record missing or duplicated: " + f.source);
    seen.add(f.source);
    const expectedSha = sha256(reviewed.text);
    if (f.sha256 !== expectedSha || f.size !== Buffer.byteLength(reviewed.text)) fail("overlay bytes differ from reviewed recipe: " + f.source);
    if (rec.recipe !== reviewed.recipe || rec.overlaySha256 !== expectedSha || !isDigest(rec.baseSha256) || rec.baseGitBlob !== f.gitBlob) fail("overlay record differs from reviewed recipe: " + f.source);
  }
}

function checkDependencies(plan) {
  const dep = plan.dependencies;
  if (!isPlain(dep) || dep.lockfileVersion !== 3 || !isDigest(dep.lockSha256) || !Array.isArray(dep.packages) || !isPlain(dep.entries)) fail("invalid dependency plan");
  if (!dep.packages.length || dep.packages.length > DEFAULT_LIMITS.maxDependencies) fail("dependency count out of range");
  if (Object.keys(dep.entries).length !== dep.packages.length) fail("dependency entries do not match packages");
  const packages = [];
  let last = "";
  for (const p of dep.packages) {
    if (!isPlain(p) || typeof p.path !== "string") fail("invalid planned package");
    const names = packageNamesOf(p.path);
    if (p.path <= last) fail("planned packages must be unique and sorted");
    last = p.path;
    const entry = Object.hasOwn(dep.entries, p.path) ? dep.entries[p.path] : undefined;
    if (!isPlain(entry) || entry.version !== p.version || entry.resolved !== p.resolved || entry.integrity !== p.integrity) fail("lock entry differs from planned package: " + p.path);
    if (typeof p.version !== "string" || !VERSION.test(p.version)) fail("planned version is not exact: " + p.path);
    if (typeof p.resolved !== "string" || !p.resolved.startsWith("https://registry.npmjs.org/") || typeof p.integrity !== "string" || !/^sha512-[A-Za-z0-9+/=]+$/.test(p.integrity)) fail("planned package source is not a pinned registry tarball: " + p.path);
    if (JSON.stringify(p.os) !== JSON.stringify(entry.os ?? null) || JSON.stringify(p.cpu) !== JSON.stringify(entry.cpu ?? null)) fail("planned os/cpu differ from the lock entry: " + p.path);
    if (entry.link || entry.hasInstallScript || entry.dev || entry.inBundle || entry.bundleDependencies || (entry.optionalDependencies && Object.keys(entry.optionalDependencies).length)) fail("planned package has a disallowed lock property: " + p.path);
    const name = entry.name === undefined ? names.at(-1) : entry.name;
    if (!validPackageName(name)) fail("invalid package name: " + p.path);
    packages.push({ path: p.path, name, version: p.version });
  }
  const sdk = packages.find((p) => p.path === SDK_PATH);
  if (!sdk || sdk.version !== BROWSER_SDK.version || sdk.name !== BROWSER_SDK.name) fail("planned SDK differs from the pinned SDK");
  return packages;
}

/**
 * Pure. Computes what a staged bundle must contain from an OK, untampered plan. Throws on any fault.
 * `expectedPlanSha256` (a pin the caller holds out of band) is optional but recommended: a digest check alone
 * only proves the plan body is self-consistent, not that it is the reviewed plan.
 * Returns exact source/root file digests and exact planned package identities; dependency file bytes are
 * NOT included because they cannot be derived from the plan.
 */
export function expectedRemoteBrowserClosure({ plan, platform, expectedPlanSha256, expectedRevision = BROWSER_SOURCE_REVISION }) {
  if (!isPlain(plan) || plan.ok !== true || !Array.isArray(plan.blockers) || plan.blockers.length !== 0) fail("plan must be OK with no blockers");
  if (!/^[0-9a-f]{40}$/.test(expectedRevision) || plan.revision !== expectedRevision) fail("plan revision differs from the expected revision");
  if (!isDigest(plan.planSha256) || remoteBrowserPlanSha256(plan) !== plan.planSha256) fail("plan body does not match planSha256");
  if (expectedPlanSha256 !== undefined && (!isDigest(expectedPlanSha256) || expectedPlanSha256 !== plan.planSha256)) fail("plan differs from the pinned planSha256");
  if (!Array.isArray(plan.files) || !plan.files.length || plan.files.length > DEFAULT_LIMITS.maxFiles) fail("invalid plan files");
  let total = 0, last = "";
  for (const f of plan.files) {
    if (!isPlain(f) || typeof f.source !== "string") fail("invalid plan file");
    validateRelativePath(f.source);
    if (!SOURCE_DIRS.some((d) => f.source.startsWith(d)) || !f.source.endsWith(".mjs")) fail("plan file is outside src/v0 and src/live: " + f.source);
    if (f.source <= last) fail("plan files must be unique and sorted");
    last = f.source;
    if (!isDigest(f.sha256) || !isSize(f.size) || !/^[0-9a-f]{40}$/.test(f.gitBlob) || typeof f.executable !== "boolean" || !["git", "overlay"].includes(f.origin)) fail("invalid plan file fields: " + f.source);
    total += f.size;
  }
  if (plan.totalBytes !== total) fail("plan totalBytes does not match files");
  if (!Array.isArray(plan.bareImports) || plan.bareImports.some((s) => typeof s !== "string" || (s !== BROWSER_SDK.name && !s.startsWith(BROWSER_SDK.name + "/")))) fail("plan has a bare import outside the pinned SDK");
  checkOverlays(plan);
  const packages = checkDependencies(plan);
  if (lockPlatformMismatches(plan, platform).length) fail("planned packages exclude the target platform");

  const files = new Map();
  const minimal = minimalDependencyFiles(plan);
  for (const name of ROOT_FILES) files.set(name, { size: Buffer.byteLength(minimal[name]), sha256: minimal.digests[name], kind: "dependency-manifest" });
  for (const f of plan.files) files.set("browser-harness/" + f.source, { size: f.size, sha256: f.sha256, kind: f.origin === "overlay" ? "overlay" : "source" });
  return Object.freeze({ planSha256: plan.planSha256, revision: plan.revision, lockSha256: plan.dependencies.lockSha256, platform, files, packages: Object.freeze(packages) });
}

function validateTrustedInventory(trusted, limits) {
  if (!exactKeys(trusted, ["archiveSha256", "files"]) && !exactKeys(trusted, ["archiveSha256", "files", "dependencyInventorySha256"])) fail("trusted dependency inventory must be { archiveSha256, files[, dependencyInventorySha256] }");
  if (!isDigest(trusted.archiveSha256) || !Array.isArray(trusted.files) || !trusted.files.length || trusted.files.length > limits.files) fail("invalid trusted dependency inventory");
  const map = new Map();
  for (const f of trusted.files) {
    if (!exactKeys(f, ["path", "size", "sha256"]) || !isSize(f.size) || !isDigest(f.sha256)) fail("invalid trusted dependency inventory entry");
    validateRelativePath(f.path);
    if (!f.path.startsWith("node_modules/") || map.has(f.path)) fail("trusted dependency inventory paths must be unique node_modules paths");
    map.set(f.path, f);
  }
  const inventorySha256 = remoteBrowserDependencyInventorySha256(trusted.files);
  if (trusted.dependencyInventorySha256 !== undefined && trusted.dependencyInventorySha256 !== inventorySha256) fail("trusted dependencyInventorySha256 does not match its files");
  return { map, inventorySha256 };
}

/** Longest planned-package prefix owning a node_modules file, or a failure for unknown prefixes and .bin. */
function owningPackage(path, packagePaths) {
  if (path === HIDDEN_LOCKFILE) return undefined;
  if (path.startsWith("node_modules/.") && !path.startsWith("node_modules/.bin/")) fail("node_modules root metadata other than the hidden lockfile is not allowed: " + path);
  let best;
  for (const p of packagePaths) if (path.startsWith(p + "/") && (!best || p.length > best.length)) best = p;
  if (!best) fail(path.startsWith("node_modules/.bin/") ? "node_modules/.bin is not allowed: " + path : "unplanned node_modules path: " + path);
  const rest = path.slice(best.length + 1);
  if (rest === "node_modules" || rest.startsWith("node_modules/")) fail(rest.startsWith("node_modules/.bin") ? "node_modules/.bin is not allowed: " + path : "unplanned nested node_modules path: " + path);
  return best;
}

// Bounded, O_NOFOLLOW, regular-file read that re-hashes the bytes it parses against `entry.sha256`
// (already equal to the plan-derived or trusted-inventory digest), so a swap after bundle verification fails.
function readBoundedJson(root, relativePath, entry, maxBytes) {
  if (entry.size > maxBytes) fail("JSON file exceeds size limit: " + relativePath);
  const path = join(root, relativePath);
  for (let parent = dirname(path); parent !== root; parent = dirname(parent)) {
    const st = lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022)) fail("unsafe package directory: " + relativePath);
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size !== entry.size || (st.mode & 0o022)) fail("file is not the inventoried regular file: " + relativePath);
    const bytes = Buffer.alloc(entry.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) fail("file shrank: " + relativePath);
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, offset) !== 0) fail("file grew: " + relativePath);
    if (sha256(bytes) !== entry.sha256) fail("file bytes changed after bundle verification: " + relativePath);
    let json;
    try { json = JSON.parse(bytes.toString("utf8")); } catch { fail("file is not valid JSON: " + relativePath); }
    return json;
  } finally { closeSync(fd); }
}

const DESCRIPTOR_KEYS = ["version", "directory", "platform", "nodeVersion", "chromePath", "files", "sourcePlanSha256", "dependenciesLockSha256", "dependenciesArtifactSha256"];

/**
 * Strict host verification of a staged bundle against an OK plan, a validated runtime attestation and a
 * TRUSTED, independently derived dependency inventory.
 *
 * Caller contract for `trustedHostDependencyInventory`:
 *   { archiveSha256, files: [{ path: "node_modules/...", size, sha256 }, ...] }
 * It must be produced by the host from the dependency archive whose tar.gz SHA-256 is `archiveSha256`
 * (extracted into a private scratch tree and hashed there), never copied from the descriptor. It lists every
 * regular file under node_modules, including node_modules/.package-lock.json when npm wrote it. Without it this
 * function fails: lock SRI values and package versions do not prove extracted npm bytes.
 *
 * Runs the full verifyRemoteBrowserBundle first (symlink, writable, digest, ELF checks), then compares exact
 * inventories, then reads each planned package.json (bounded, O_NOFOLLOW, regular file, re-hashed).
 * `descriptor` is deep-copied once so later mutation or getters cannot change what was checked.
 */
export function verifyRemoteBrowserClosure({ descriptor, plan, attestation, trustedHostDependencyInventory, expectedPlanSha256, expectedRevision, platform, nodeVersion, limits = BROWSER_BUNDLE_LIMITS }) {
  if (trustedHostDependencyInventory === undefined || trustedHostDependencyInventory === null) fail("a trusted host-derived dependency inventory is required");
  if (!validateRuntimeAttestation(attestation)) fail("runtime attestation is invalid");
  if ((platform !== undefined && platform !== attestation.platform) || (nodeVersion !== undefined && nodeVersion !== attestation.node)) fail("requested platform/node differ from the attestation");
  let snapshot;
  try { snapshot = structuredClone(descriptor); } catch { fail("descriptor must be plain data"); }
  const expected = expectedRemoteBrowserClosure({ plan, platform: attestation.platform, expectedPlanSha256, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
  if (!exactKeys(snapshot, DESCRIPTOR_KEYS)) fail("descriptor has missing or unexpected fields");
  if (snapshot.platform !== attestation.platform || snapshot.nodeVersion !== attestation.node) fail("descriptor platform/node differ from the attestation");
  if (snapshot.sourcePlanSha256 !== expected.planSha256) fail("descriptor sourcePlanSha256 differs from the plan");
  if (snapshot.dependenciesLockSha256 !== expected.lockSha256 || attestation.dependenciesLockSha256 !== expected.lockSha256) fail("dependency lock digest differs from the plan");
  if (snapshot.dependenciesArtifactSha256 !== attestation.dependenciesArtifactSha256) fail("descriptor dependency archive digest differs from the attestation");
  if (trustedHostDependencyInventory.files === snapshot.files || trustedHostDependencyInventory.files === descriptor?.files) fail("trusted inventory must not be the descriptor's own inventory");
  const trusted = validateTrustedInventory(trustedHostDependencyInventory, limits);
  if (trustedHostDependencyInventory.archiveSha256 !== attestation.dependenciesArtifactSha256) fail("trusted inventory is bound to a different dependency archive");
  if (!Array.isArray(snapshot.files) || snapshot.files.some((f) => !exactKeys(f, ["path", "size", "sha256"]) || typeof f.path !== "string")) fail("descriptor file entries must be { path, size, sha256 }");

  const bundle = verifyRemoteBrowserBundle(snapshot, { platform: attestation.platform, nodeVersion: attestation.node, limits });

  // Exact inventory comparison. Bundle verification already proved each listed file matches its listed digest.
  const listed = new Map(snapshot.files.map((f) => [f.path, f]));
  const chrome = listed.get(snapshot.chromePath);
  if (!chrome || expected.files.has(snapshot.chromePath) || snapshot.chromePath.startsWith("browser-harness/") || snapshot.chromePath.startsWith("node_modules/")) fail("Chrome path collides with the planned closure");
  if (chrome.sha256 !== attestation.chrome.sha256) fail("Chrome binary digest differs from the attestation");
  const packagePaths = expected.packages.map((p) => p.path);
  let dependencyFiles = 0;
  for (const [path, entry] of listed) {
    if (path === snapshot.chromePath) continue;
    const want = expected.files.get(path);
    if (want) {
      if (entry.size !== want.size || entry.sha256 !== want.sha256) fail("planned " + want.kind + " bytes differ: " + path);
    } else if (path.startsWith("node_modules/")) {
      owningPackage(path, packagePaths);
      const t = trusted.map.get(path);
      if (!t || t.size !== entry.size || t.sha256 !== entry.sha256) fail("dependency file differs from the trusted inventory: " + path);
      dependencyFiles++;
    } else fail("unexpected bundle path: " + path);
  }
  for (const path of expected.files.keys()) if (!listed.has(path)) fail("planned file is missing: " + path);
  if (dependencyFiles !== trusted.map.size) fail("trusted inventory lists files that the bundle lacks");

  const packages = [];
  for (const p of expected.packages) {
    const rel = p.path + "/package.json";
    const entry = listed.get(rel);
    if (!entry) fail("planned package has no package.json: " + p.path);
    const json = readBoundedJson(bundle.directory, rel, entry, BROWSER_CLOSURE_LIMITS.packageJsonBytes);
    if (!isPlain(json) || json.name !== p.name || json.version !== p.version) fail("package identity differs from the plan: " + p.path);
    packages.push({ path: p.path, name: p.name, version: p.version });
  }
  const hiddenLockfile = listed.get(HIDDEN_LOCKFILE);
  if (hiddenLockfile) {
    if (!trusted.map.has(HIDDEN_LOCKFILE)) fail("hidden lockfile is not bound by the trusted inventory");
    const hidden = readBoundedJson(bundle.directory, HIDDEN_LOCKFILE, hiddenLockfile, BROWSER_CLOSURE_LIMITS.hiddenLockfileBytes);
    if (!isPlain(hidden) || hidden.lockfileVersion !== 3 || !isPlain(hidden.packages)) fail("hidden lockfile must be lockfileVersion 3");
    const members = Object.keys(hidden.packages).sort();
    if (members.length !== expected.packages.length || members.some((m, i) => m !== packagePaths[i])) fail("hidden lockfile package membership differs from the plan");
    for (const p of expected.packages) {
      const h = hidden.packages[p.path], planned = plan.dependencies.entries[p.path];
      if (!isPlain(h) || h.version !== p.version || (h.resolved !== undefined && h.resolved !== planned.resolved) || (h.integrity !== undefined && h.integrity !== planned.integrity) || h.link) fail("hidden lockfile entry differs from the plan: " + p.path);
    }
  }
  return Object.freeze({
    verified: true, hiddenLockfileChecked: Boolean(hiddenLockfile), directory: bundle.directory, chromePath: bundle.chromePath, platform: attestation.platform, nodeVersion: attestation.node,
    planSha256: expected.planSha256, dependenciesLockSha256: expected.lockSha256, dependenciesArtifactSha256: attestation.dependenciesArtifactSha256,
    dependencyInventorySha256: trusted.inventorySha256, packages: Object.freeze(packages),
    // Honest scope: these are NOT established by this function.
    chromeAuxiliaryClosureProven: false, sameUidImmutabilityProven: false,
  });
}
