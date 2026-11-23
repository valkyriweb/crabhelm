import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { applianceKey, buildAppliance, ensureAppliance } from "../lib/appliance.mjs";
import { loadConfig } from "../lib/config.mjs";
import { Crabbox } from "../lib/crabbox.mjs";

const heavy = fileURLToPath(new URL("../bin/lane-heavy.mjs", import.meta.url));
const installer = fileURLToPath(new URL("../bin/install-crabbox-linux.sh", import.meta.url));
const mini = "lue-and-naddy-server";
const profiles = [
  ["agent-runner", "cpu2", "amd64"],
  ["asus-laptop-1", "cpu2", "amd64"],
  ["lue-and-naddy-mbp-old", "cpu4", "amd64"],
  [mini, "cpu1", "arm64"],
];
const sink = { write() {} };

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "crabbox-lanes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const [machine, type, arch] of profiles) {
  test(`agent-run pins ${machine} to ${type} with no fallback`, async () => {
    const config = loadConfig({ AGENT_RUN_LANE_MACHINE: machine });
    const crabbox = new Crabbox(config, {
      runner: async (command, args) => {
        assert.equal(command, "crabbox");
        assert.deepEqual(args, ["warmup", "--provider", "serve", "--type", type, "--class", "standard", "--slug", "s",
          "--serve-machine", machine + "-hc-serve", "--arch", arch, "--serve-fallback=", "--idle-timeout", "75m", "--ttl", "90m"]);
        return { code: 1, stdout: "", stderr: "serve_capacity_unavailable" };
      },
    });
    await assert.rejects(crabbox.warmup("s", sink), { capacity: true });
  });
}

test("unknown, conflicting and banned lane selections fail closed", () => {
  for (const name of ["", "typo", "rp-kube-01", "constructor"]) {
    assert.throws(() => loadConfig({ AGENT_RUN_LANE_MACHINE: name }), /known Herdr machine/);
  }
  const lane = { AGENT_RUN_LANE_MACHINE: "agent-runner" };
  assert.throws(() => loadConfig({ ...lane, AGENT_RUN_CRABBOX_PROVIDER: "aws" }), /requires provider serve/);
  assert.throws(() => loadConfig({ ...lane, AGENT_RUN_CRABBOX_TYPE: "cpu4" }), /conflicts.*cpu2/);
  assert.throws(() => loadConfig({ ...lane, AGENT_RUN_CRABBOX_MACHINE: "other" }), /conflicts/);
  assert.throws(() => loadConfig({ ...lane, AGENT_RUN_CRABBOX_MACHINE: "rp-kube-01" }), /banned/);
  assert.throws(() => loadConfig({ ...lane, AGENT_RUN_LANE_ARCH: "arm64" }), /only for the Mac mini/);
  assert.equal(loadConfig({ AGENT_RUN_LANE_MACHINE: mini, AGENT_RUN_LANE_ARCH: "amd64" }).serveLane.arch, "amd64");
  assert.equal(loadConfig({ AGENT_RUN_CRABBOX_MACHINE: "legacy-donor" }).crabboxMachine, "legacy-donor");
});

test("Mac mini cannot build or reuse a non-Pi appliance", async () => {
  const config = loadConfig({ AGENT_RUN_LANE_MACHINE: mini });
  for (const build of [buildAppliance, ensureAppliance]) {
    await assert.rejects(build({ config, pins: {}, harness: "codex" }), /only accepts lightweight Pi/);
  }
});

test("Mac mini Pi assembly uses the arm64 Node and package pins, not the x64 cache", async (t) => {
  const cacheDir = scratch(t);
  const node = Buffer.from("arm64 Node fixture");
  const pack = Buffer.from("npm fixture");
  const pins = {
    node: { version: "1", url: "https://fixture/x64", arm64: {
      url: "https://fixture/arm64", sha256: createHash("sha256").update(node).digest("hex"),
    } },
    harnesses: { pi: { package: "pi", version: "1", bin: "pi" } },
  };
  const legacyKey = applianceKey(pins, "pi");
  const cached = join(cacheDir, "x64.tgz");
  const legacyHash = createHash("sha256").update("x64 archive").digest("hex");
  writeFileSync(cached, "x64 archive");
  mkdirSync(join(cacheDir, "appliances"));
  writeFileSync(join(cacheDir, "appliances", "index.json"), JSON.stringify({ [legacyKey]: { path: cached, sha256: legacyHash } }));
  const fetched = [];
  const result = await ensureAppliance({
    config: { ...loadConfig({ AGENT_RUN_LANE_MACHINE: mini }), cacheDir }, pins, harness: "pi", log: sink,
    fetcher: async (url) => {
      fetched.push(url);
      return new Response(url === pins.node.arm64.url ? node : pack);
    },
    runner: async (command, args, options = {}) => {
      if (command === "npm") {
        if (args[0] === "install") {
          const pkg = (cpu) => ({ os: ["linux"], cpu: [cpu], resolved: "https://fixture/pi-" + cpu,
            integrity: "sha512-" + createHash("sha512").update(pack).digest("base64") });
          writeFileSync(join(options.cwd, "package-lock.json"), JSON.stringify({ packages: {
            "node_modules/pi-arm64": pkg("arm64"), "node_modules/pi-x64": pkg("x64"),
          } }));
        } else if (args[0] === "ci") {
          assert.ok(args.includes("--cpu=arm64"));
          mkdirSync(join(options.cwd, "node_modules", ".bin"), { recursive: true });
          writeFileSync(join(options.cwd, "node_modules", ".bin", "pi"), "fixture");
        } else {
          assert.deepEqual(args.slice(0, 2), ["cache", "add"]);
        }
        return { code: 0 };
      }
      return { code: 0, stdout: execFileSync(command, args, options).toString() };
    },
  });
  assert.equal(result.key, legacyKey + "-linux-arm64");
  assert.deepEqual(fetched, [pins.node.arm64.url, "https://fixture/pi-arm64"]);
  assert.deepEqual(execFileSync("tar", ["-xOf", result.path, "node.tgz"]), node);
  assert.equal(readFileSync(cached, "utf8"), "x64 archive");
});

test("lane-heavy passes the same sizes and strict pins to heavy", { skip: !["linux", "darwin"].includes(process.platform) }, (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, "heavy"), `#!${process.execPath}\nconsole.log(JSON.stringify({ args: process.argv.slice(2), machine: process.env.CRABBOX_SERVE_MACHINE, fallback: process.env.CRABBOX_SERVE_FALLBACK, arch: process.env.CRABBOX_ARCH }));\nprocess.exit(75);`, { mode: 0o755 });
  const env = { PATH: `${dir}:${process.env.PATH}`, CRABBOX_SERVE_MACHINE: "old-donor", CRABBOX_SERVE_FALLBACK: "aws", CRABBOX_ARCH: "unexpected" };
  const call = (...args) => spawnSync(process.execPath, [heavy, ...args], { env, encoding: "utf8" });
  for (const [machine, type, arch] of profiles) {
    const result = call(machine, ...(machine === mini ? ["--light"] : []), "--no-sync", "--", "printf", "%s", "two words");
    assert.equal(result.status, 75, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["--remote", "--type", type, "--no-sync", "--", "printf", "%s", "two words"],
      machine: machine + "-hc-serve", fallback: "serve", arch,
    });
  }
  assert.match(call(mini, "--", "true").stderr, /requires --light/);
  assert.equal(call("agent-runner", "--local", "--", "true").status, 2);
  assert.equal(call("agent-runner", "--type", "cpu8", "--", "true").status, 2);
});

test("Linux installer dry-run is network- and write-free; bad archives never reach tar", { skip: process.platform !== "linux" }, (t) => {
  const dir = scratch(t);
  const bin = join(dir, "bin");
  const home = join(dir, "home with spaces");
  mkdirSync(bin);
  const trace = join(dir, "calls");
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, TRACE: trace, PLATFORM: "Linux x86_64" };
  writeFileSync(join(bin, "uname"), '#!/bin/sh\nprintf "%s\\n" "$PLATFORM"\n', { mode: 0o755 });
  writeFileSync(join(bin, "curl"), '#!/bin/sh\nprintf "curl\\n" >> "$TRACE"\nwhile [ "$1" != --output ]; do shift; done\nprintf corrupt > "$2"\n', { mode: 0o755 });
  writeFileSync(join(bin, "tar"), '#!/bin/sh\nprintf "tar\\n" >> "$TRACE"\nexit 1\n', { mode: 0o755 });
  const call = (platform, ...args) => spawnSync("bash", [installer, ...args], { env: { ...env, PLATFORM: platform }, encoding: "utf8" });
  const dry = call("Linux x86_64", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /v0\.79\.1-valky\.11/);
  assert.match(dry.stdout, /SHA-256: [0-9a-f]{64}/);
  assert.equal(call("Linux aarch64", "--dry-run").status, 1);
  assert.equal(existsSync(home), false);
  assert.equal(existsSync(trace), false);
  const bad = call("Linux x86_64");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /SHA-256 mismatch/);
  assert.equal(readFileSync(trace, "utf8"), "curl\n");
  assert.equal(existsSync(join(home, ".local/bin/crabbox")), false);
  const dest = join(home, ".local/bin");
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, "crabbox"), "unmanaged");
  assert.match(call("Linux x86_64").stderr, /leaving it alone/);
  assert.equal(readFileSync(join(dest, "crabbox"), "utf8"), "unmanaged");
  assert.equal(readFileSync(trace, "utf8"), "curl\n");
});
