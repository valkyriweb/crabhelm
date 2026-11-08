import { posix } from "node:path";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const digest = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const revision = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const fail = (reason) => { throw new Error("remote-child: " + reason); };
const fields = (value, allowed, label) => {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) fail("unsupported " + label);
};
const identityFields = ["forkVersion", "forkRevision", "myPiVersion", "myPiRevision", "profileSha256"];

function identity(value) {
  fields(value, identityFields, "runtime identity");
  if (!["forkVersion", "myPiVersion"].every((k) => typeof value[k] === "string" && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(value[k])) ||
      !revision(value.forkRevision) || !revision(value.myPiRevision) || !digest(value.profileSha256)) fail("incomplete runtime identity");
}

export function validateRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) ||
      posix.isAbsolute(value) || posix.normalize(value) !== value || value.split("/").some((s) => !s || s === "." || s === "..") ||
      /^[A-Za-z]:/.test(value)) fail("resource path must be canonical and relative");
  return value;
}

function credentialPath(path) {
  const parts = path.toLowerCase().split("/");
  return parts.some((p) => [".ssh", ".aws", ".kube", ".gnupg"].includes(p)) ||
    /^(?:auth\.json|mcp-auth\.json|models\.json|\.npmrc|\.netrc|id_rsa|id_ed25519|\.env(?:\..*)?)$/.test(parts.at(-1));
}

// Attestations belong to the host policy/configuration, never the uploaded manifest.
// Missing scope is unknown even when configuration contains no inline secret.
export function classifyMcpServer(config, attestation) {
  fields(config, ["name", "enabled", "required", "configSha256"], "MCP inventory");
  if (typeof config.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(config.name) || typeof config.enabled !== "boolean" ||
      typeof config.required !== "boolean" || !digest(config.configSha256)) fail("invalid MCP inventory");
  const unavailable = (reason) => ({ placement: config.required ? "local" : "unavailable", reason });
  if (!config.enabled) return config.required ? unavailable("required MCP is disabled") : { placement: "disabled", reason: "disabled by effective child configuration" };
  if (!object(attestation) || attestation.configSha256 !== config.configSha256 || !digest(attestation.evidenceSha256)) {
    return unavailable("MCP provenance/account scope is unverified");
  }
  if (attestation.placement === "unavailable") return unavailable("MCP explicitly unavailable under host policy");
  if (attestation.accountScope === "personal") return { placement: "stop", reason: "personal-account MCP must not be exposed to donor" };
  if (attestation.placement === "proxy") return unavailable("MCP account proxies are outside this transport");
  if (attestation.accountScope !== "nonpersonal") return unavailable("MCP account scope is unknown");
  if (attestation.credentials !== "none" && attestation.credentials !== "ephemeral") {
    return unavailable("MCP requires reusable or unknown credentials");
  }
  if (attestation.placement === "donor" && digest(attestation.serverArtifactSha256)) {
    return { placement: "donor", reason: "pinned server with verified nonpersonal scope" };
  }
  return unavailable("MCP transport/dependency closure is unavailable");
}

export function validateRemoteChildManifest(value, expected) {
  fields(value, ["version", "runtime", "files", "mcp"], "manifest");
  if (value.version !== 1 || !Array.isArray(value.files) || !Array.isArray(value.mcp)) fail("expected version 1 file/MCP manifest");
  fields(value.runtime, ["identity", "platform", "artifactSha256"], "runtime");
  identity(value.runtime.identity);
  identity(expected?.identity);
  if (!identityFields.every((k) => value.runtime.identity[k] === expected.identity[k])) fail("runtime/profile identity mismatch; keep child local");
  if (!["linux-x64", "linux-arm64"].includes(value.runtime.platform) || value.runtime.platform !== expected.platform ||
      !digest(value.runtime.artifactSha256) || value.runtime.artifactSha256 !== expected.artifactSha256) fail("Linux runtime artifact mismatch; keep child local");
  const paths = [];
  for (const file of value.files) {
    fields(file, ["root", "source", "target", "sha256", "size", "kind", "executable"], "resource entry");
    if (typeof file.root !== "string" || !/^[A-Za-z0-9_-]+$/.test(file.root) ||
        !["workspace", "skill", "extension", "instruction", "config"].includes(file.kind) ||
        typeof file.executable !== "boolean" || !digest(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0) fail("invalid resource entry");
    validateRelativePath(file.source);
    validateRelativePath(file.target);
    if (credentialPath(file.source) || credentialPath(file.target)) fail("credential-store path is not a transferable resource");
    paths.push(file.target.normalize("NFC").toLowerCase());
  }
  const destinations = new Set(paths);
  if (destinations.size !== paths.length) fail("resource destinations collide");
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (destinations.has(parts.slice(0, i).join("/"))) fail("resource destinations collide");
    }
  }
  const fileFields = ["root", "source", "target", "sha256", "size", "kind", "executable"];
  if (!Array.isArray(expected.files) || expected.files.length !== value.files.length) fail("required resource membership mismatch");
  const captured = new Map(expected.files.map((f) => [f.target, f]));
  if (captured.size !== expected.files.length || value.files.some((f) => !captured.has(f.target) ||
      !fileFields.every((key) => f[key] === captured.get(f.target)[key]))) fail("required resource membership/digest mismatch");
  if (!Array.isArray(expected.mcp)) fail("missing host MCP inventory");
  const required = new Map();
  for (const entry of expected.mcp) {
    const decision = classifyMcpServer(entry.config, entry.attestation);
    if (required.has(entry.config.name)) fail("duplicate host MCP inventory");
    required.set(entry.config.name, { config: entry.config, decision });
  }
  const seen = new Set();
  for (const server of value.mcp) {
    fields(server, ["name", "configSha256", "placement"], "MCP manifest entry");
    const entry = required.get(server.name);
    if (!entry || seen.has(server.name) || server.configSha256 !== entry.config.configSha256 || server.placement !== entry.decision.placement) fail("MCP membership/configuration mismatch");
    if (server.placement === "stop") fail("personal-account MCP must not be exposed to donor");
    if (server.placement === "local") fail("required MCP unavailable; keep child local");
    seen.add(server.name);
  }
  if (seen.size !== required.size) fail("MCP membership/configuration mismatch");
  return value;
}
