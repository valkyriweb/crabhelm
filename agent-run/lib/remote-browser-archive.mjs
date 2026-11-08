import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, accessSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_BUNDLE_LIMITS } from "./remote-browser-bundle.mjs";
import { BROWSER_CLOSURE_LIMITS, HIDDEN_LOCKFILE, remoteBrowserDependencyInventorySha256 } from "./remote-browser-closure.mjs";
import { minimalDependencyFiles } from "./remote-browser-package.mjs";
import { validateRelativePath } from "./remote-child-contract.mjs";

/*
 * Host-side derivation of `trustedHostDependencyInventory` from the ACTUAL dependency tar.gz, without
 * extracting or executing any archive content. A host-chosen Python 3 (stdlib tarfile) lists and hashes the
 * members from an inherited, already-validated file descriptor; this module re-checks every path.
 *
 * Trust inputs (caller-held, never from the bundle or its descriptor): expectedArchiveSha256, the python3
 * executable path, and either a plan (exact root bytes are regenerated) or expectedRootFiles.
 * Output shape matches verifyRemoteBrowserClosure: dependencyInventorySha256 uses the existing helper.
 * Limitations: same-UID TOCTOU after return is not prevented; Chrome and its auxiliary libraries are not covered.
 */

const fail = (reason) => { throw new Error("remote-browser-archive: " + reason); };
const isDigest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "remote-browser-archive.py");
const ROOTS = ["package.json", "package-lock.json"]; // the build archive never carries .npmrc

export const BROWSER_ARCHIVE_LIMITS = Object.freeze({
  ...BROWSER_BUNDLE_LIMITS,
  // Per-record and aggregate tar metadata (GNU long names, PAX headers) before the library reads their bodies.
  metadataRecordBytes: BROWSER_CLOSURE_LIMITS.packageJsonBytes,
  metadataTotalBytes: BROWSER_CLOSURE_LIMITS.hiddenLockfileBytes,
});

/** Preflight: python3 must be an absolute, executable path chosen by the host. Returns its version string. */
export function preflightPython3(python3) {
  if (typeof python3 !== "string" || !isAbsolute(python3) || normalize(python3) !== python3) fail("python3 must be a canonical absolute path chosen by the host");
  try { accessSync(python3, constants.X_OK); } catch { fail("python3 is not executable: " + python3); }
  let out;
  try {
    out = execFileSync(python3, ["-I", "-S", "-c", "import sys,tarfile,gzip,hashlib,json;print('%d.%d.%d'%sys.version_info[:3]);assert sys.version_info>=(3,8)"], { env: {}, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { fail("python3 preflight failed (need >= 3.8 with tarfile)"); }
  return out;
}

function expectedRoots({ plan, expectedRootFiles }) {
  if ((plan === undefined) === (expectedRootFiles === undefined)) fail("provide exactly one of plan or expectedRootFiles");
  const roots = new Map();
  if (plan !== undefined) {
    const minimal = minimalDependencyFiles(plan);
    for (const name of ROOTS) roots.set(name, { size: Buffer.byteLength(minimal[name]), sha256: minimal.digests[name] });
  } else {
    for (const name of ROOTS) {
      const r = expectedRootFiles?.[name];
      if (!r || !isDigest(r.sha256) || (r.size !== undefined && !Number.isSafeInteger(r.size))) fail("expectedRootFiles needs { sha256[, size] } for " + name);
      roots.set(name, { size: r.size, sha256: r.sha256 });
    }
  }
  return roots;
}

// Bounded regular-file nofollow open; returns { fd, stat }. Caller closes.
function openArchive(path, limits) {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path) fail("archive path must be canonical and absolute");
  for (let p = path; ; p = dirname(p)) {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) fail("archive path contains a symlink: " + p);
    if (dirname(p) === p) break;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > limits.bytes) fail("archive is not a bounded regular file");
    return { fd, st };
  } catch (e) { closeSync(fd); throw e; }
}

function hashFd(fd, size) {
  const hash = createHash("sha256"), buf = Buffer.alloc(1 << 20);
  let pos = 0;
  while (pos < size) {
    const n = readSync(fd, buf, 0, Math.min(buf.length, size - pos), pos);
    if (!n) fail("archive shrank while hashing");
    hash.update(buf.subarray(0, n)); pos += n;
  }
  if (readSync(fd, buf, 0, 1, pos) !== 0) fail("archive grew while hashing");
  return hash.digest("hex");
}

const sameStat = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev;

/** Applies the path policy to the raw member list and returns the node_modules regular files. */
function checkEntries(entries, roots, limits) {
  if (!Array.isArray(entries) || entries.length > limits.files * 2) fail("invalid member list");
  const seen = new Map(); // path -> "file" | "dir"
  const files = [];
  const rootSeen = new Set();
  for (const e of entries) {
    const path = validateRelativePath(e.path);
    const parts = path.split("/");
    if (seen.has(path)) fail("duplicate archive path: " + path);
    if (parts.includes(".bin")) fail(".bin is not allowed: " + path);
    if (parts[0] === "node_modules") {
      if (parts[1]?.startsWith(".") && path !== HIDDEN_LOCKFILE) fail("node_modules root metadata other than the hidden lockfile is not allowed: " + path);
    } else if (e.type === "file" && ROOTS.includes(path)) {
      rootSeen.add(path);
    } else fail("unknown archive root: " + path);
    if (e.type === "dir") { if (parts.length === 1 && path !== "node_modules") fail("unknown archive root: " + path); }
    else if (e.type !== "file") fail("unsupported entry type");
    seen.set(path, e.type);
    if (e.type === "file") {
      if (!Number.isSafeInteger(e.size) || e.size < 0 || !isDigest(e.sha256)) fail("invalid file record: " + path);
      if (path === "node_modules") fail("node_modules must be a directory");
      if (path === HIDDEN_LOCKFILE && e.size > BROWSER_CLOSURE_LIMITS.hiddenLockfileBytes) fail("hidden lockfile exceeds cap");
      if (parts[0] === "node_modules") files.push({ path, size: e.size, sha256: e.sha256 });
      else {
        const want = roots.get(path);
        if (e.sha256 !== want.sha256 || (want.size !== undefined && e.size !== want.size)) fail("root file differs from the expected bytes: " + path);
      }
    }
  }
  for (const name of ROOTS) if (!rootSeen.has(name)) fail("archive lacks root file: " + name);
  for (const path of seen.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) if (seen.get(parts.slice(0, i).join("/")) === "file") fail("file/directory prefix collision: " + path);
  }
  if (!files.length) fail("archive has no node_modules files");
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Derives { archiveSha256, files, dependencyInventorySha256 } from the dependency tar.gz. Throws on any fault.
 * `archiveSha256` here is the caller's `expectedArchiveSha256`, confirmed against the actual compressed bytes.
 * Pass the complete result as trustedHostDependencyInventory.
 */
export function deriveTrustedHostDependencyInventory({ archivePath, expectedArchiveSha256, python3, plan, expectedRootFiles, limits = BROWSER_ARCHIVE_LIMITS }) {
  if (!isDigest(expectedArchiveSha256)) fail("expectedArchiveSha256 must be a caller-held SHA-256");
  const roots = expectedRoots({ plan, expectedRootFiles });
  limits = { ...BROWSER_ARCHIVE_LIMITS, ...limits };
  preflightPython3(python3);
  const { fd, st } = openArchive(archivePath, limits);
  try {
    if (hashFd(fd, st.size) !== expectedArchiveSha256) fail("archive SHA-256 differs from the expected digest");
    const manifestCaps = { "package.json": BROWSER_CLOSURE_LIMITS.packageJsonBytes, "package-lock.json": BROWSER_CLOSURE_LIMITS.hiddenLockfileBytes, [HIDDEN_LOCKFILE]: BROWSER_CLOSURE_LIMITS.hiddenLockfileBytes };
    const res = spawnSync(python3, ["-I", "-S", SCRIPT, JSON.stringify({ files: limits.files, bytes: limits.bytes, metadataRecordBytes: limits.metadataRecordBytes, metadataTotalBytes: limits.metadataTotalBytes, manifestCaps })], {
      env: {}, stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8",
    });
    if (res.error || res.status !== 0) fail("archive reader rejected the archive: " + (res.error?.message ?? res.stderr.trim().slice(0, 300)));
    let out;
    try { out = JSON.parse(res.stdout); } catch { fail("archive reader returned invalid output"); }
    if (out?.archiveSha256 !== expectedArchiveSha256 || out.archiveSize !== st.size) fail("archive bytes parsed differ from the expected digest");
    if (!sameStat(st, fstatSync(fd))) fail("archive changed while being read");
    const files = checkEntries(out.entries, roots, limits);
    return Object.freeze({ archiveSha256: expectedArchiveSha256, files, dependencyInventorySha256: remoteBrowserDependencyInventorySha256(files) });
  } finally { closeSync(fd); }
}
