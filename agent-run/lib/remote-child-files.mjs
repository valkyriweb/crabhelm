import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, statfsSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateRemoteChildManifest } from "./remote-child-contract.mjs";

const fail = (reason) => { throw new Error("remote-child files: " + reason); };
const contained = (root, path) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel); };

function sourcePath(roots, entry) {
  if (!Object.hasOwn(roots, entry.root) || typeof roots[entry.root] !== "string") fail("undeclared source root");
  const root = realpathSync(roots[entry.root]);
  if (!lstatSync(root).isDirectory()) fail("source root must be a directory");
  const source = resolve(root, entry.source);
  if (!contained(root, source)) fail("source escapes declared root");
  let parent = dirname(source);
  while (parent !== root) {
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("source ancestors must be real directories");
    parent = dirname(parent);
  }
  const stat = lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("only regular source files are supported");
  return source;
}

// The scanner is host-owned. Its digest must attest the same staged bytes, not
// an earlier mutable source. Nothing may upload a bundle before this returns.
export async function stageRemoteChildFiles({ manifest, expected, roots, destination, scanFile }) {
  validateRemoteChildManifest(manifest, expected);
  if (typeof scanFile !== "function") fail("approved secret scanner is required");
  if (!roots || typeof roots !== "object" || Array.isArray(roots)) fail("source roots are required");
  if (typeof destination !== "string" || !isAbsolute(destination)) fail("destination must be absolute");
  const stage = resolve(destination);
  // Never clean or reuse an existing directory, including another lane’s work.
  mkdirSync(stage, { mode: 0o700 });
  let complete = false;
  try {
    const capacity = statfsSync(stage, { bigint: true });
    const bytes = manifest.files.reduce((sum, entry) => sum + BigInt(entry.size), 0n);
    if (bytes > capacity.bavail * capacity.bsize) fail("insufficient staging capacity");
    const proof = [];
    for (const entry of manifest.files) {
      let input;
      let output;
      const target = join(stage, entry.target);
      try {
        input = openSync(sourcePath(roots, entry), constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = fstatSync(input);
        if (!before.isFile() || before.size !== entry.size) fail("source type/size changed");
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        output = openSync(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, entry.executable ? 0o700 : 0o600);
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let copied = 0;
        for (;;) {
          const count = readSync(input, buffer);
          if (!count) break;
          copied += count;
          if (copied > entry.size) fail("source grew during capture");
          const chunk = buffer.subarray(0, count);
          hash.update(chunk);
          let written = 0;
          while (written < count) {
            const amount = writeSync(output, chunk, written, count - written);
            if (!amount) fail("staging write made no progress");
            written += amount;
          }
        }
        const after = fstatSync(input);
        if (copied !== entry.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
            after.size !== before.size || hash.digest("hex") !== entry.sha256) fail("source digest changed");
      } finally {
        if (input !== undefined) closeSync(input);
        if (output !== undefined) closeSync(output);
      }
      let scan;
      try { scan = await scanFile(target); } catch { fail("secret scanner failed"); }
      if (!scan || scan.sha256 !== entry.sha256 || !Number.isSafeInteger(scan.findings) || scan.findings < 0) fail("secret scanner proof is incomplete");
      if (scan.findings !== 0) fail("secret scan rejected resource; findings=" + scan.findings);
      if (scan.ok !== true) fail("secret scanner failed");
      proof.push({ target: entry.target, sha256: entry.sha256, size: entry.size, findings: 0 });
    }
    complete = true;
    return { directory: stage, files: proof, bytes: String(bytes), scanned: true };
  } catch (error) {
    // Filesystem exceptions can contain private source paths; expose no raw error.
    if (error instanceof Error && error.message.startsWith("remote-child")) throw error;
    fail("capture failed; source or staging filesystem changed");
  } finally {
    if (!complete) rmSync(stage, { recursive: true, force: true });
  }
}
