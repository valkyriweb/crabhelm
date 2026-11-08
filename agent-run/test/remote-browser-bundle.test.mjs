import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { verifyRemoteBrowserBundle } from "../lib/remote-browser-bundle.mjs";
function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "browser-bundle-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = [];
  for (const path of ["package.json", "node_modules/@modelcontextprotocol/sdk/package.json", "browser-harness/src/v0/engine.mjs", "browser-harness/src/v0/tools.mjs", "browser-harness/src/v0/chrome.mjs", "chrome/chrome"]) {
    const content = Buffer.alloc(24); content.write("\x7fELF"); content[4] = 2; content[5] = 1; content.writeUInt16LE(62, 18);
    mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, path), content, { mode: 0o700 });
    files.push({ path, size: content.length, sha256: createHash("sha256").update(content).digest("hex") });
  }
  return { version: 1, directory, platform: "linux-x64", nodeVersion: "22.19.0", chromePath: "chrome/chrome", files,
    sourcePlanSha256: "a".repeat(64), dependenciesLockSha256: "b".repeat(64), dependenciesArtifactSha256: "c".repeat(64) };
}
test("group/world writable roots, directories and files fail closed", t => {
  const d = fixture(t);
  for (const path of [d.directory, join(d.directory, "node_modules"), join(d.directory, "package.json")]) {
    chmodSync(path, 0o722);
    assert.throws(() => verifyRemoteBrowserBundle(d, options), /writable/);
    chmodSync(path, 0o700);
  }
});
const options = { platform: "linux-x64", nodeVersion: "22.19.0" };
test("complete digest-bound Linux bundle verifies without executing any code", t => {
  const descriptor = fixture(t); const proof = verifyRemoteBrowserBundle(descriptor, options);
  assert.equal(proof.verified, true); assert.equal(proof.files.size, 6);
});
test("runtime mismatch, traversal, duplicates, missing members and limits fail closed", t => {
  const d = fixture(t);
  assert.throws(() => verifyRemoteBrowserBundle(d, { ...options, platform: "darwin-arm64" }));
  assert.throws(() => verifyRemoteBrowserBundle(d, { ...options, nodeVersion: "23.0.0" }));
  for (const files of [[...d.files, d.files[0]], d.files.slice(1), [...d.files, { path: "../secret", size: 0, sha256: "d".repeat(64) }]]) assert.throws(() => verifyRemoteBrowserBundle({ ...d, files }, options));
  assert.throws(() => verifyRemoteBrowserBundle(d, { ...options, limits: { files: 20, bytes: 10 } }));
});
test("modified and unlisted files fail verification", t => {
  const d = fixture(t);
  writeFileSync(join(d.directory, "extra"), "unlisted");
  assert.throws(() => verifyRemoteBrowserBundle(d, options), /unexpected/);
  rmSync(join(d.directory, "extra"));
  writeFileSync(join(d.directory, d.files[0].path), "changed");
  assert.throws(() => verifyRemoteBrowserBundle(d, options), /changed/);
});
test("dependency symlinks and wrong Chrome architecture fail closed", t => {
  const d = fixture(t);
  symlinkSync("package.json", join(d.directory, "link"));
  assert.throws(() => verifyRemoteBrowserBundle(d, options), /nonregular/);
  rmSync(join(d.directory, "link"));
  assert.throws(() => verifyRemoteBrowserBundle({ ...d, platform: "linux-arm64" }, { ...options, platform: "linux-arm64" }), /Linux ELF/);
});
