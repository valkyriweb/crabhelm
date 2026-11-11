#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants, openSync, readSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyRemoteBrowserBundle } from "./remote-browser-bundle.mjs";
import { prepareRemoteBrowserEnvironment, remoteBrowserEngineFactory } from "./remote-browser-runtime.mjs";
import { startRemoteBrowserStdio } from "./remote-browser-stdio.mjs";
const fail = () => { throw new Error("remote-browser: verified donor bundle required"); };

export function readRemoteBrowserDescriptor(path, expectedSha256) {
  if (typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)) fail();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size < 1 || before.size > 4 * 1024 * 1024) fail();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset);
      if (!count) fail();
      offset += count;
    }
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) fail();
    return JSON.parse(bytes.toString("utf8"));
  } finally { closeSync(fd); }
}

// This entry is a dedicated donor process. Never call it in the parent's Pi process.
async function start(descriptor, runDirectory) {
  const bundle = verifyRemoteBrowserBundle(descriptor);
  const metadata = JSON.parse(readFileSync(join(bundle.directory, "node_modules/@modelcontextprotocol/sdk/package.json"), "utf8"));
  if (metadata.name !== "@modelcontextprotocol/sdk" || metadata.version !== "1.32.0") fail();
  const runtime = prepareRemoteBrowserEnvironment({ runDirectory, chromePath: bundle.chromePath });
  // Chrome's spawn() and some source defaults use process.env, not the engine's env.
  // The supervisor must also spawn this entry with a scrubbed environment so that
  // NODE_OPTIONS/NODE_PATH cannot affect code loading before this entry executes.
  process.env = { ...runtime.env };
  const require = createRequire(join(bundle.directory, "package.json"));
  const load = path => {
    const rel = relative(bundle.directory, path).split("\\").join("/");
    if (!bundle.files.has(rel)) fail();
    return import(pathToFileURL(path).href);
  };
  const sdkModule = name => load(require.resolve("@modelcontextprotocol/sdk/" + name));
  const [{ Server }, { StdioServerTransport }, schemas, { TOOLS }] = await Promise.all([
    sdkModule("server/index.js"), sdkModule("server/stdio.js"), sdkModule("types.js"),
    load(join(bundle.directory, "browser-harness/src/v0/tools.mjs")),
  ]);
  // Load the guarded source closure now, not on a much later first tool call.
  const [engineModule, chromeModule] = await Promise.all([
    load(join(bundle.directory, "browser-harness/src/v0/engine.mjs")),
    load(join(bundle.directory, "browser-harness/src/v0/chrome.mjs")),
  ]);
  return startRemoteBrowserStdio({
    sdk: { Server, StdioServerTransport, ...schemas }, tools: TOOLS,
    createEngine: remoteBrowserEngineFactory({ runtime,
      loadEngine: async () => engineModule,
      loadChrome: async () => chromeModule,
    }),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 8 || process.argv[2] !== "--descriptor" || process.argv[4] !== "--sha256" || process.argv[6] !== "--run-directory") fail();
    const descriptor = readRemoteBrowserDescriptor(process.argv[3], process.argv[5]);
    const handle = await start(descriptor, process.argv[7]);
    let stopping = false;
    const parent = process.ppid;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(7), 10000);
      try { await handle.close(); clearTimeout(deadline); process.exit(0); }
      catch { process.exit(7); }
    };
    handle.server.onclose = stop;
    process.stdin.once("end", stop); process.stdin.once("close", stop);
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    setInterval(() => { if (process.ppid !== parent) void stop(); }, 1000).unref();
  } catch {
    process.stderr.write("remote-browser: donor bundle/startup verification failed\n");
    process.exitCode = 7;
  }
}
