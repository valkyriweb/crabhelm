import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyMcpServer, validateRelativePath, validateRemoteChildManifest } from "../lib/remote-child-contract.mjs";

const sha = "a".repeat(64);
const config = { name: "project_files", enabled: true, required: true, configSha256: sha };
const attestation = { configSha256: sha, evidenceSha256: sha, accountScope: "nonpersonal", credentials: "none", placement: "donor", serverArtifactSha256: sha };
function fixture() {
  const identity = { forkVersion: "1.4.0", forkRevision: "b".repeat(40), myPiVersion: "0.1.0", myPiRevision: "c".repeat(40), profileSha256: sha };
  const files = [{ root: "project", source: "readme.txt", target: "workspace/readme.txt", sha256: sha, size: 12, kind: "workspace", executable: false }];
  const expected = { identity, platform: "linux-x64", artifactSha256: sha, files: structuredClone(files), mcp: [{ config, attestation }] };
  const manifest = { version: 1, runtime: { identity: structuredClone(identity), platform: expected.platform, artifactSha256: sha }, files, mcp: [{ name: config.name, configSha256: sha, placement: "donor" }] };
  return { expected, manifest };
}

test("requires matching pinned fork, my-pi, profile, platform and artifact", () => {
  const { manifest, expected } = fixture();
  assert.equal(validateRemoteChildManifest(manifest, expected), manifest);
  for (const key of ["forkVersion", "forkRevision", "myPiVersion", "myPiRevision", "profileSha256"]) {
    const changed = structuredClone(manifest);
    changed.runtime.identity[key] = key.endsWith("Version") ? "9.0.0" : "d".repeat(key.endsWith("Revision") ? 40 : 64);
    assert.throws(() => validateRemoteChildManifest(changed, expected), /identity mismatch/);
  }
  for (const [key, value] of [["platform", "darwin-arm64"], ["platform", "linux-arm64"], ["artifactSha256", "e".repeat(64)]]) {
    const changed = structuredClone(manifest); changed.runtime[key] = value;
    assert.throws(() => validateRemoteChildManifest(changed, expected), /artifact mismatch/);
  }
  assert.throws(() => validateRemoteChildManifest(manifest), /runtime identity/);
});

test("rejects unknown manifest fields and incomplete identities", () => {
  const { manifest, expected } = fixture();
  assert.throws(() => validateRemoteChildManifest({ ...manifest, homeArchive: true }, expected), /unsupported manifest/);
  delete manifest.runtime.identity.forkRevision;
  assert.throws(() => validateRemoteChildManifest(manifest, expected), /incomplete runtime/);
});

test("paths must be canonical relative POSIX paths", () => {
  for (const path of ["", "/etc/passwd", "../key", "x/../y", "a//b", "a/", "./a", "a/./b", "C:/keys", "a\\b", "a\u0000b", "a\nb"]) assert.throws(() => validateRelativePath(path), /canonical/);
  assert.equal(validateRelativePath("workspace/a b.txt"), "workspace/a b.txt");
});

test("credential store paths cannot be packaged, including renamed stores", () => {
  for (const source of [".env", "a/.env.local", "auth.json", "mcp-auth.json", "models.json", ".ssh/config", ".aws/credentials", ".kube/config", "id_ed25519", ".npmrc"]) {
    const { manifest, expected } = fixture(); manifest.files[0].source = source;
    assert.throws(() => validateRemoteChildManifest(manifest, expected), /credential-store/);
  }
  const { manifest, expected } = fixture(); manifest.files[0].target = "profile/auth.json";
  assert.throws(() => validateRemoteChildManifest(manifest, expected), /credential-store/);
});

test("detects duplicates, ancestor files, case and Unicode collisions", () => {
  for (const targets of [["a", "a"], ["a", "a-b", "a/b"], ["a/B", "a/b"], ["a/é", "a/e\u0301"]]) {
    const { manifest, expected } = fixture();
    manifest.files = targets.map((target) => ({ ...manifest.files[0], target }));
    assert.throws(() => validateRemoteChildManifest(manifest, expected), /collide/);
  }
});

test("required resources cannot be omitted, added or changed", () => {
  for (const change of [(m) => m.files.pop(), (m) => m.files.push({ ...m.files[0], target: "extra" }), (m) => { m.files[0].sha256 = "d".repeat(64); }, (m) => { m.files[0].source = "other.txt"; }]) {
    const { manifest, expected } = fixture(); change(manifest);
    assert.throws(() => validateRemoteChildManifest(manifest, expected), /resource membership/);
  }
});

test("MCP scope and provenance are never inferred from name or absent credentials", () => {
  assert.equal(classifyMcpServer(config).placement, "local");
  assert.equal(classifyMcpServer(config, { ...attestation, configSha256: "d".repeat(64) }).placement, "local");
  assert.equal(classifyMcpServer(config, { ...attestation, accountScope: "unknown" }).placement, "local");
  assert.equal(classifyMcpServer(config, { ...attestation, credentials: "reusable" }).placement, "local");
  assert.equal(classifyMcpServer(config, attestation).placement, "donor");
  assert.equal(classifyMcpServer({ ...config, enabled: false, required: false }).placement, "disabled");
});

test("personal-account scope stops both donor and proxy exposure", () => {
  for (const placement of ["donor", "proxy"]) assert.equal(classifyMcpServer(config, { ...attestation, accountScope: "personal", placement }).placement, "stop");
});

test("nonpersonal proxies remain outside B3 even with an approval record", () => {
  const proxy = { ...attestation, placement: "proxy" };
  assert.equal(classifyMcpServer(config, proxy).placement, "local");
  assert.equal(classifyMcpServer(config, { ...proxy, capabilities: ["lookup"], proxyApprovalSha256: sha }).placement, "local");
  assert.equal(classifyMcpServer(config, { ...proxy, capabilities: ["*"], proxyApprovalSha256: sha }).placement, "local");
});

test("explicitly unavailable nonrequired MCP is recorded without removing stock tools", () => {
  const { manifest, expected } = fixture();
  expected.mcp[0].config = { ...config, required: false };
  expected.mcp[0].attestation = { ...attestation, placement: "unavailable", accountScope: "personal" };
  manifest.mcp[0].placement = "unavailable";
  assert.equal(validateRemoteChildManifest(manifest, expected), manifest);
  assert.equal(classifyMcpServer(expected.mcp[0].config).placement, "unavailable");
  expected.mcp[0].config.required = true; manifest.mcp[0].placement = "local";
  assert.throws(() => validateRemoteChildManifest(manifest, expected), /MCP unavailable/);
});

test("MCP membership must exactly match the captured child configuration", () => {
  for (const change of [(m) => m.mcp.pop(), (m) => m.mcp.push(m.mcp[0]), (m) => { m.mcp[0].name = "other"; }, (m) => { m.mcp[0].placement = "proxy"; }]) {
    const { manifest, expected } = fixture(); change(manifest);
    assert.throws(() => validateRemoteChildManifest(manifest, expected), /MCP membership/);
  }
  const { manifest, expected } = fixture(); delete expected.mcp[0].attestation; manifest.mcp[0].placement = "local";
  assert.throws(() => validateRemoteChildManifest(manifest, expected), /MCP unavailable/);
});
