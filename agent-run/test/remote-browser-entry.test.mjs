import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readRemoteBrowserDescriptor } from "../lib/remote-browser-entry.mjs";
test("descriptor bytes must match the host-supplied digest", t => {
  const root = mkdtempSync(join(tmpdir(), "browser-descriptor-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "descriptor.json"), bytes = JSON.stringify({ version: 1 });
  writeFileSync(path, bytes);
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(readRemoteBrowserDescriptor(path, sha), { version: 1 });
  assert.throws(() => readRemoteBrowserDescriptor(path, "0".repeat(64)));
  assert.throws(() => readRemoteBrowserDescriptor(path, "bad"));
  symlinkSync(path, join(root, "link"));
  assert.throws(() => readRemoteBrowserDescriptor(join(root, "link"), sha));
});
test("standalone startup rejects unsupported args without exposing paths or loading SDK", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../lib/remote-browser-entry.mjs", import.meta.url)), "--unknown", "/private/source"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 10000 });
  assert.equal(result.status, 7); assert.equal(result.stdout, "");
  assert.equal(result.stderr, "remote-browser: donor bundle/startup verification failed\n");
});
