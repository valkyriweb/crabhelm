import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createRemoteBrowserServer, startRemoteBrowserStdio } from "../lib/remote-browser-stdio.mjs";
const tools = [
  { name: "browser_open", inputSchema: { type: "object", properties: { url: { type: "string" } } } },
  { name: "browser_jev" }, { name: "browser_import" }, { name: "browser_end", inputSchema: { type: "object", properties: {} } },
];
function fixture(createEngine) {
  class Server {
    handlers = new Map(); closed = false;
    constructor(info, options) { this.info = info; this.options = options; }
    setRequestHandler(schema, handler) { this.handlers.set(schema, handler); }
    async connect(transport) { this.transport = transport; }
    async close() { this.closed = true; }
  }
  const sdk = { Server, ListToolsRequestSchema: "list", CallToolRequestSchema: "call", StdioServerTransport: class {} };
  const handle = createRemoteBrowserServer({ sdk, tools, createEngine });
  return { ...handle, sdk, call: (name, args, signal) => handle.server.handlers.get("call")({ params: { name, arguments: args } }, { signal }) };
}
test("MCP dispatch rejects account paths before constructing engine", async () => {
  let constructions = 0;
  const h = fixture(() => { constructions++; throw new Error("must not run"); });
  for (const [name, args] of [["browser_import", {}], ["browser_jev", {}], ["browser_eval", {}], ["browser_open", { profile: "live" }], ["browser_open", { import: [] }]]) {
    assert.equal((await h.call(name, args)).isError, true);
  }
  assert.equal(constructions, 0);
  const list = await h.server.handlers.get("list")();
  assert.deepEqual(list.tools.map(t => t.name), ["browser_open", "browser_end"]);
  list.tools.pop();
  assert.equal((await h.server.handlers.get("list")()).tools.length, 2);
  assert.deepEqual(await h.close(), { drained: true, processCleanupVerified: false });
});
test("concurrent MCP calls share one in-process engine and guarded arguments", async () => {
  let constructions = 0, closed = 0;
  const calls = [];
  const h = fixture(async () => { constructions++; return { execute: async (...args) => { calls.push(args); return { content: [] }; }, closeAll: async () => { closed++; } }; });
  await Promise.all([h.call("browser_open", { url: "about:blank" }), h.call("browser_end", {})]);
  assert.equal(constructions, 1);
  assert.deepEqual(calls[0], ["remote-task", "browser_open", { url: "about:blank", profile: "agent", ephemeral: true }]);
  const first = h.close();
  assert.equal(first, h.close());
  await first;
  assert.equal(closed, 1);
  assert.equal((await h.call("browser_open", {})).isError, true);
});
test("shutdown closes Chrome before waiting for a blocked call and rejects new work", async () => {
  let release, entered, closed = false;
  const started = new Promise(r => { entered = r; });
  const wait = new Promise(r => { release = r; });
  const h = fixture(() => ({ execute: async () => { entered(); await wait; return { content: [] }; }, closeAll: async () => { closed = true; release(); } }));
  const call = h.call("browser_open", {});
  await started;
  const closing = h.close();
  assert.equal((await h.call("browser_end", {})).isError, true);
  await call;
  assert.equal((await closing).drained, true);
  assert.equal(closed, true);
});
test("shutdown during engine construction never dispatches a late call", async () => {
  let ready, entered, executed = 0, closed = 0;
  const started = new Promise(r => { entered = r; });
  const engine = new Promise(r => { ready = r; });
  const h = fixture(() => { entered(); return engine; });
  const call = h.call("browser_open", {});
  await started;
  const closing = h.close();
  ready({ execute: async () => { executed++; }, closeAll: async () => { closed++; } });
  assert.equal((await call).isError, true);
  await closing;
  assert.equal(executed, 0); assert.equal(closed, 1);
});
test("cancel before dispatch starts no engine; engine errors expose no raw details", async () => {
  let constructions = 0;
  const h = fixture(() => { constructions++; throw new Error("secret-private-path"); });
  const ac = new AbortController(); ac.abort();
  assert.equal((await h.call("browser_open", {}, ac.signal)).isError, true);
  assert.equal(constructions, 0);
  const reply = await h.call("browser_open", {});
  assert.equal(reply.isError, true);
  assert.doesNotMatch(JSON.stringify(reply), /secret-private-path/);
  await h.close();
});
test("engine close failure remains a failure, never a successful cleanup receipt", async () => {
  const h = fixture(() => ({ execute: async () => ({ content: [] }), closeAll: async () => { throw new Error("cleanup failed"); } }));
  await h.call("browser_end", {});
  await assert.rejects(h.close(), /cleanup failed/);
});
test("stdio connector uses only the supplied verified transport", async () => {
  const h = fixture(() => { throw new Error("list must stay lazy"); });
  const handle = await startRemoteBrowserStdio({ sdk: h.sdk, tools, createEngine: () => { throw new Error("unused"); } });
  assert.ok(handle.server.transport instanceof h.sdk.StdioServerTransport);
  await handle.close(); await h.close();
});

test("real MCP SDK initializes, lists guarded tools and routes calls in process", { skip: !process.env.REMOTE_BROWSER_TEST_PACKAGE }, async () => {
  const require = createRequire(resolve(process.env.REMOTE_BROWSER_TEST_PACKAGE, "package.json"));
  const load = async path => import(pathToFileURL(require.resolve("@modelcontextprotocol/sdk/" + path)).href);
  const [{ Server }, { Client }, { InMemoryTransport }, schemas] = await Promise.all([
    load("server/index.js"), load("client/index.js"), load("inMemory.js"), load("types.js"),
  ]);
  let dispatched = 0, stopped = 0;
  const handle = createRemoteBrowserServer({
    sdk: { Server, ...schemas }, tools,
    createEngine: () => ({ execute: async (_session, _name, args) => {
      dispatched++;
      assert.equal(args.profile, "agent"); assert.equal(args.ephemeral, true);
      return { content: [{ type: "text", text: "synthetic donor dispatch" }] };
    }, closeAll: async () => { stopped++; } }),
  });
  const client = new Client({ name: "remote-browser-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["browser_open", "browser_end"]);
    assert.equal((await client.callTool({ name: "browser_open", arguments: { profile: "live" } })).isError, true);
    assert.equal(dispatched, 0);
    const result = await client.callTool({ name: "browser_open", arguments: { url: "about:blank" } });
    assert.equal(result.content[0].text, "synthetic donor dispatch");
    assert.equal(dispatched, 1);
  } finally {
    await handle.close(); await client.close();
  }
  assert.equal(stopped, 1);
});
