import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRemoteBrowserEnvironment, remoteBrowserEngineFactory } from "../lib/remote-browser-runtime.mjs";
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "remote-browser-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const chromePath = join(root, "chrome"); writeFileSync(chromePath, "synthetic executable; never run", { mode: 0o700 });
  return { runDirectory: root, chromePath };
}
test("private runtime uses a fresh home and excludes all inherited account and focus settings", t => {
  const input = fixture(t);
  const runtime = prepareRemoteBrowserEnvironment(input);
  assert.equal(runtime.env.BH_HEADLESS, "1"); assert.equal(runtime.env.BH_LIVE, "0");
  assert.equal(runtime.env.BH_IMPORT_DIR, undefined); assert.equal(runtime.env.JEV_API_KEY, undefined);
  assert.equal(runtime.env.BH_FLAGS_ADD, undefined); assert.equal(runtime.env.BH_ALLOW_FOCUS, undefined);
  assert.equal(runtime.env.CI, undefined); assert.equal(runtime.env.NODE_OPTIONS, undefined);
  assert.equal(runtime.env.BH_CHROME, input.chromePath);
  for (const path of [runtime.directory, runtime.env.HOME, runtime.env.TMPDIR, runtime.env.BH_HOME, runtime.shotsDirectory]) assert.equal(statSync(path).mode & 0o777, 0o700);
  assert.throws(() => prepareRemoteBrowserEnvironment(input));
});
test("shared or noncanonical directories and nonexecutable browser paths fail before startup", t => {
  const input = fixture(t);
  chmodSync(input.runDirectory, 0o755);
  assert.throws(() => prepareRemoteBrowserEnvironment(input));
  chmodSync(input.runDirectory, 0o700); chmodSync(input.chromePath, 0o600);
  assert.throws(() => prepareRemoteBrowserEnvironment(input));
  assert.throws(() => prepareRemoteBrowserEnvironment({ ...input, runDirectory: input.runDirectory + "/../elsewhere" }));
});
test("launch wrapper forces headless ephemeral pipe for every engine launch, including tabs-new", async t => {
  const runtime = prepareRemoteBrowserEnvironment(fixture(t));
  let engineOptions, launched;
  const create = remoteBrowserEngineFactory({ runtime,
    loadEngine: async () => ({ Engine: class { constructor(options) { engineOptions = options; } } }),
    loadChrome: async () => ({ launchChrome: options => { launched = options; return "launched"; } }),
  });
  await create();
  assert.equal(engineOptions.shotsDir, runtime.shotsDirectory);
  assert.equal(engineOptions.launch({ profile: "agent", ephemeral: false, headless: false, env: { BH_ALLOW_FOCUS: "1" } }), "launched");
  assert.deepEqual(launched, { profile: "agent", ephemeral: true, headless: true, transport: "pipe", env: runtime.env });
  assert.throws(() => engineOptions.launch({ seed: () => {} }));
  assert.throws(() => engineOptions.launch({ profile: "live" }));
});
test("engine environment cannot reintroduce imports, transport overrides or account settings", t => {
  const runtime = prepareRemoteBrowserEnvironment(fixture(t));
  for (const change of [{ BH_IMPORT_DIR: "/outside" }, { BH_FLAGS_ADD: "--no-sandbox" }, { BH_HEADLESS: "0" }, { CI: "true" }]) {
    assert.throws(() => remoteBrowserEngineFactory({ runtime: { ...runtime, env: { ...runtime.env, ...change } }, loadEngine: async () => ({}), loadChrome: async () => ({}) }));
  }
});
