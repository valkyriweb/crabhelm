import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { join, isAbsolute, normalize, dirname } from "node:path";
import { validateRelativePath } from "./remote-child-contract.mjs";
const fail = reason => { throw new Error("remote-browser-bundle: " + reason); };
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const BROWSER_BUNDLE_LIMITS = Object.freeze({ files: 20000, bytes: 1024 * 1024 * 1024 });

export function verifyRemoteBrowserBundle(descriptor, { platform = process.platform + "-" + process.arch, nodeVersion = process.versions.node, limits = BROWSER_BUNDLE_LIMITS } = {}) {
  if (!descriptor || descriptor.version !== 1 || !["linux-x64", "linux-arm64"].includes(descriptor.platform) || descriptor.platform !== platform ||
      descriptor.nodeVersion !== nodeVersion || !Array.isArray(descriptor.files) || !descriptor.files.length || descriptor.files.length > limits.files ||
      !digest(descriptor.sourcePlanSha256) || !digest(descriptor.dependenciesLockSha256) || !digest(descriptor.dependenciesArtifactSha256)) fail("incomplete or mismatched Linux runtime descriptor");
  const root = descriptor.directory;
  if (typeof root !== "string" || !isAbsolute(root) || normalize(root) !== root || realpathSync(root) !== root || !lstatSync(root).isDirectory()) fail("bundle root must be canonical");
  if (lstatSync(root).mode & 0o022) fail("bundle root must not be group/world writable");
  const paths = new Set();
  let bytes = 0;
  for (const entry of descriptor.files) {
    validateRelativePath(entry.path);
    if (paths.has(entry.path) || !digest(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) fail("invalid file inventory");
    paths.add(entry.path); bytes += entry.size;
    if (!Number.isSafeInteger(bytes) || bytes > limits.bytes) fail("bundle exceeds byte limit");
  }
  for (const required of ["package.json", "node_modules/@modelcontextprotocol/sdk/package.json", "browser-harness/src/v0/engine.mjs", "browser-harness/src/v0/tools.mjs", "browser-harness/src/v0/chrome.mjs", descriptor.chromePath]) {
    validateRelativePath(required);
    if (!paths.has(required)) fail("incomplete executable bundle");
  }
  // Reject unexpected files and every symlink, including dependency symlinks.
  const todo = [""];
  let seen = 0, directories = 0;
  while (todo.length) {
    const directory = todo.pop();
    for (const child of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory ? directory + "/" + child.name : child.name;
      validateRelativePath(path);
      if (child.isDirectory()) {
        if (lstatSync(join(root, path)).mode & 0o022) fail("bundle directory must not be group/world writable");
        if (++directories > limits.files) fail("bundle exceeds directory limit"); todo.push(path);
      }
      else if (!child.isFile() || !paths.has(path) || ++seen > limits.files) fail("unexpected or nonregular bundle file");
    }
  }
  if (seen !== paths.size) fail("bundle file membership mismatch");
  for (const entry of descriptor.files) {
    const path = join(root, entry.path);
    for (let parent = dirname(path); parent !== root; parent = dirname(parent)) if (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink()) fail("symlinked bundle ancestor");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size !== entry.size) fail("bundle file changed");
      if (before.mode & 0o022) fail("bundle file must not be group/world writable");
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
      let total = 0;
      for (;;) {
        const count = readSync(fd, buffer);
        if (!count) break;
        total += count;
        if (total > entry.size) fail("bundle file grew");
        hash.update(buffer.subarray(0, count));
      }
      const after = fstatSync(fd);
      if (total !== entry.size || hash.digest("hex") !== entry.sha256 || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail("bundle digest changed");
    } finally { closeSync(fd); }
  }
  const chromePath = join(root, descriptor.chromePath);
  const fd = openSync(chromePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(20);
    if (readSync(fd, header) !== 20 || header.toString("hex", 0, 4) !== "7f454c46" || header[4] !== 2 || header[5] !== 1 ||
        header.readUInt16LE(18) !== (platform === "linux-x64" ? 62 : 183) || !(fstatSync(fd).mode & 0o111)) fail("Chrome must be the attested executable Linux ELF");
  } finally { closeSync(fd); }
  return { directory: root, chromePath, files: paths, bytes, platform, nodeVersion, verified: true };
}
