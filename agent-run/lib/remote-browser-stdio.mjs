import { guardRemoteBrowserCall, remoteBrowserTools, REMOTE_BROWSER_INSTRUCTIONS } from "./remote-browser-policy.mjs";

// Dependencies come from the verified donor bundle, never a host daemon or wrapper.
export function createRemoteBrowserServer({ sdk, tools, createEngine }) {
  if (typeof sdk?.Server !== "function" || !sdk.ListToolsRequestSchema || !sdk.CallToolRequestSchema || typeof createEngine !== "function") {
    throw new TypeError("remote-browser: verified SDK and engine factory are required");
  }
  const declarations = remoteBrowserTools(tools);
  const names = new Set(declarations.map(tool => tool.name));
  const server = new sdk.Server({ name: "remote-task-browser", version: "1.0.0" }, {
    capabilities: { tools: {} }, instructions: REMOTE_BROWSER_INSTRUCTIONS,
  });
  const pending = new Set();
  const stats = { accepted: 0, denied: 0, failed: 0 };
  let enginePromise;
  let closing = false;
  let closePromise;
  const errorReply = text => ({ isError: true, content: [{ type: "text", text }] });
  server.setRequestHandler(sdk.ListToolsRequestSchema, async () => ({ tools: structuredClone(declarations) }));
  server.setRequestHandler(sdk.CallToolRequestSchema, ({ params }, extra) => {
    if (closing || extra?.signal?.aborted) {
      stats.denied++;
      return errorReply("remote-browser: closed or cancelled before dispatch");
    }
    let args;
    try {
      if (!names.has(params.name)) throw new Error("unavailable");
      args = guardRemoteBrowserCall(params.name, params.arguments ?? {});
    } catch {
      stats.denied++;
      return errorReply("remote-browser: tool or arguments unavailable under task-only policy");
    }
    stats.accepted++;
    const call = (async () => {
      try {
        enginePromise ??= Promise.resolve().then(createEngine).then(engine => {
          if (typeof engine?.execute !== "function" || typeof engine?.closeAll !== "function") throw new Error("invalid engine");
          return engine;
        });
        const engine = await enginePromise;
        if (closing || extra?.signal?.aborted) return errorReply("remote-browser: closed or cancelled before dispatch");
        // The engine has no per-call abort. Shutdown closes Chrome while calls
        // drain; only the supervisor can prove process-group absence.
        return await engine.execute("remote-task", params.name, args);
      } catch {
        stats.failed++;
        return errorReply("remote-browser: execution failed");
      }
    })();
    pending.add(call);
    void call.finally(() => pending.delete(call));
    return call;
  });
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      const stopEngine = async () => {
        if (!enginePromise) return;
        let engine;
        try { engine = await enginePromise; } catch { /* No engine was constructed. */ }
        if (engine) await engine.closeAll();
      };
      // Never let a hung execute() prevent the Chrome shutdown attempt.
      const [cleanup] = await Promise.allSettled([stopEngine(), ...pending]);
      await server.close();
      if (cleanup.status === "rejected") throw cleanup.reason;
      // Engine shutdown alone does not prove Chrome/process-group absence.
      return { drained: pending.size === 0, processCleanupVerified: false };
    })();
    return closePromise;
  };
  return { server, close, stats: () => ({ ...stats, active: pending.size, closing }) };
}

export async function startRemoteBrowserStdio(options) {
  if (typeof options?.sdk?.StdioServerTransport !== "function") throw new TypeError("remote-browser: verified stdio transport is required");
  const handle = createRemoteBrowserServer(options);
  try { await handle.server.connect(new options.sdk.StdioServerTransport()); }
  catch (error) { await handle.close(); throw error; }
  return handle;
}
