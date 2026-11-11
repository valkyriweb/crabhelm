import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
const fail = () => { throw new Error("remote-browser: private canonical runtime paths are required"); };
const canonical = path => {
  if (typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path || /[\x00-\x1f\x7f]/.test(path)) fail();
  return path;
};

// The supervisor creates the private run directory. Never reuse a browser home.
// Spawn this MCP process with precisely this environment, not {...process.env}.
export function prepareRemoteBrowserEnvironment({ runDirectory, chromePath }) {
  canonical(runDirectory); canonical(chromePath);
  const stat = lstatSync(runDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(runDirectory) !== runDirectory ||
      (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) fail();
  const chrome = lstatSync(chromePath);
  if (!chrome.isFile() || chrome.isSymbolicLink() || realpathSync(chromePath) !== chromePath || (chrome.mode & 0o111) === 0) fail();
  const directory = join(runDirectory, "browser");
  mkdirSync(directory, { mode: 0o700 });
  for (const child of ["home", "tmp", "state", "shots"]) mkdirSync(join(directory, child), { mode: 0o700 });
  const env = {
    PATH: "/usr/bin:/bin", HOME: join(directory, "home"), TMPDIR: join(directory, "tmp"),
    LANG: "C.UTF-8", TZ: "UTC", BH_HOME: join(directory, "state"), BH_CHROME: chromePath,
    BH_INPROCESS: "1", BH_HEADLESS: "1", BH_LIVE: "0", BH_TRANSPORT: "pipe", BH_GRACE_MS: "0",
    BH_EVAL_TOOL: "1", BH_NETWORK_TOOL: "1",
  };
  return { env: Object.freeze(env), shotsDirectory: join(directory, "shots"), directory };
}

export function remoteBrowserEngineFactory({ runtime, loadEngine, loadChrome }) {
  const env = runtime?.env;
  if (!env || env.BH_HEADLESS !== "1" || env.BH_LIVE !== "0" || env.BH_INPROCESS !== "1" || env.BH_TRANSPORT !== "pipe" ||
      Object.keys(env).some(key => !["PATH", "HOME", "TMPDIR", "LANG", "TZ", "BH_HOME", "BH_CHROME", "BH_INPROCESS", "BH_HEADLESS", "BH_LIVE", "BH_TRANSPORT", "BH_GRACE_MS", "BH_EVAL_TOOL", "BH_NETWORK_TOOL"].includes(key)) ||
      typeof loadEngine !== "function" || typeof loadChrome !== "function") fail();
  const pinnedEnv = Object.freeze({ ...env });
  return async () => {
    const [{ Engine }, { launchChrome }] = await Promise.all([loadEngine(), loadChrome()]);
    if (typeof Engine !== "function" || typeof launchChrome !== "function") fail();
    return new Engine({ env: pinnedEnv, shotsDir: runtime.shotsDirectory, launch: options => {
      if (options?.seed || (options?.profile && options.profile !== "agent")) throw new Error("remote-browser: imports and non-task profiles are unavailable");
      // Tabs opened before browser_open also pass through this launch guard.
      return launchChrome({ profile: "agent", ephemeral: true, headless: true, transport: "pipe", env: pinnedEnv });
    } });
  };
}
