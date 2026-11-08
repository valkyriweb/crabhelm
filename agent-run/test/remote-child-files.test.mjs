import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stageRemoteChildFiles } from "../lib/remote-child-files.mjs";

const hash = (data) => createHash("sha256").update(data).digest("hex");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "remote-child-files-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, "source"); mkdirSync(source);
  const text = "selected resource\n"; writeFileSync(join(source, "a.txt"), text);
  const identity = { forkVersion: "1.4.0", forkRevision: "a".repeat(40), myPiVersion: "0.1.0", myPiRevision: "b".repeat(40), profileSha256: "c".repeat(64) };
  const runtime = { identity, platform: "linux-x64", artifactSha256: "d".repeat(64) };
  const files = [{ root: "project", source: "a.txt", target: "workspace/a.txt", sha256: hash(text), size: Buffer.byteLength(text), kind: "workspace", executable: false }];
  const manifest = { version: 1, runtime, files, mcp: [] };
  return { manifest, expected: { ...runtime, files: structuredClone(files), mcp: [] }, roots: { project: source }, destination: join(dir, "stage"), scanFile: async (path) => ({ sha256: hash(readFileSync(path)), ok: true, findings: 0 }) };
}

test("stages only declared regular files with private modes and matching scan proofs", async (t) => {
  const options = fixture(t); writeFileSync(join(options.roots.project, "unselected.txt"), "private");
  const proof = await stageRemoteChildFiles(options);
  assert.equal(proof.files.length, 1); assert.equal(proof.scanned, true);
  assert.equal(readFileSync(join(proof.directory, "workspace/a.txt"), "utf8"), "selected resource\n");
  assert.equal(existsSync(join(proof.directory, "workspace/unselected.txt")), false);
  assert.equal(statSync(proof.directory).mode & 0o777, 0o700);
  assert.equal(statSync(join(proof.directory, "workspace/a.txt")).mode & 0o777, 0o600);
});

test("changed source bytes or size fail and remove staging", async (t) => {
  for (const content of ["SELECTED RESOURCE\n", "too long to match the captured size"]) {
    const options = fixture(t); writeFileSync(join(options.roots.project, "a.txt"), content);
    await assert.rejects(stageRemoteChildFiles(options), /source .* changed/);
    assert.equal(existsSync(options.destination), false);
  }
});

test("rejects symlink files and symlink ancestors even within declared roots", async (t) => {
  for (const nested of [false, true]) {
    const options = fixture(t);
    if (nested) {
      mkdirSync(join(options.roots.project, "actual")); writeFileSync(join(options.roots.project, "actual/a.txt"), "selected resource\n");
      symlinkSync("actual", join(options.roots.project, "alias"));
      options.manifest.files[0].source = "alias/a.txt";
    } else {
      symlinkSync("a.txt", join(options.roots.project, "alias")); options.manifest.files[0].source = "alias";
    }
    options.expected.files = structuredClone(options.manifest.files);
    await assert.rejects(stageRemoteChildFiles(options), /regular source files|real directories/);
    assert.equal(existsSync(options.destination), false);
  }
});

test("missing scanner, findings, scanner failure and stale scan digest fail closed", async (t) => {
  for (const scanFile of [undefined, async () => { throw new Error("do not echo scanner output"); }, async () => ({ sha256: "0".repeat(64), ok: true, findings: 0 }), async (path) => ({ sha256: hash(readFileSync(path)), ok: false, findings: 2 })]) {
    const options = fixture(t); options.scanFile = scanFile;
    await assert.rejects(stageRemoteChildFiles(options), /scanner|findings=2/);
    assert.equal(existsSync(options.destination), false);
  }
});

test("never deletes or reuses an existing staging directory", async (t) => {
  const options = fixture(t); mkdirSync(options.destination);
  writeFileSync(join(options.destination, "foreign.txt"), "preserve");
  await assert.rejects(stageRemoteChildFiles(options), /EEXIST/);
  assert.equal(readFileSync(join(options.destination, "foreign.txt"), "utf8"), "preserve");
});

test("unknown source root fails without leaving partial working set", async (t) => {
  const options = fixture(t); options.roots = {};
  await assert.rejects(stageRemoteChildFiles(options), /undeclared source root/);
  assert.equal(existsSync(options.destination), false);
});
