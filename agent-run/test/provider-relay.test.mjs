import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { test } from "node:test";
import { startProviderRelay } from "../lib/provider-relay.mjs";

const TOKEN = "synthetic-token-abc123";
const MODEL = "vendor/model-x";
const PATH = "/v1/chat/completions";

async function fake(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    handler(req, res, seen);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    seen,
    origin: `http://127.0.0.1:${server.address().port}`,
    stop: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}
const ok = (body = '{"ok":true}', type = "application/json") => (_q, res) => {
  res.writeHead(200, { "content-type": type, "set-cookie": "s=1", "x-leak": TOKEN });
  res.end(body);
};
const opts = (origin, extra = {}) => ({
  origin, model: MODEL, token: TOKEN, deadlineMs: 5000, maxRequestBytes: 1024, maxResponseBytes: 1024, ...extra,
});
function call(relay, { method = "POST", path = PATH, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = httpRequest({ host: "127.0.0.1", port: relay.port, method, path, agent: false, headers: { "content-type": "application/json", authorization: "Bearer donor", cookie: "d=1", ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(data);
  });
}
const good = { model: MODEL, messages: [] };

test("selected model succeeds with injected auth only", async () => {
  const up = await fake(ok());
  const relay = await startProviderRelay(opts(up.origin));
  try {
    const r = await call(relay, { body: good });
    assert.equal(r.status, 200);
    assert.equal(r.text, '{"ok":true}');
    assert.equal(r.headers["set-cookie"], undefined);
    assert.equal(r.headers["x-leak"], undefined);
    assert.ok(!JSON.stringify(r).includes(TOKEN));
    const s = up.seen[0];
    assert.equal(s.url, PATH);
    assert.equal(s.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(s.headers.cookie, undefined);
    assert.equal(s.body, JSON.stringify(good));
    const st = relay.stats();
    assert.equal(st.forwarded, 1);
    assert.equal(st.requestBytes, Buffer.byteLength(s.body));
    assert.equal(st.responseBytes, 11);
  } finally {
    const proof = await relay.close();
    assert.equal(proof.listening, false);
    assert.equal(proof.closed, true);
    await up.stop();
  }
});

test("SSE buffered response is returned whole", async () => {
  const up = await fake(ok("data: a\n\ndata: [DONE]\n\n", "text/event-stream"));
  const relay = await startProviderRelay(opts(up.origin));
  try {
    const r = await call(relay, { body: good });
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-type"], "text/event-stream");
    assert.equal(r.text, "data: a\n\ndata: [DONE]\n\n");
  } finally { await relay.close(); await up.stop(); }
});

test("denies wrong path, query, method, model, malformed JSON, content type, host", async () => {
  const cases = [
    { path: "/v1/models", method: "GET" },
    { path: PATH + "?x=1", body: good },
    { path: "/admin", body: good },
    { method: "GET" },
    { body: { model: "other" } },
    { body: "{nope" },
    { body: "[1]" },
    { body: good, headers: { "content-type": "text/plain" } },
    { body: good, headers: { host: "evil.example" } },
  ];
  for (const c of cases) {
    const up = await fake(ok());
    const relay = await startProviderRelay(opts(up.origin));
    try {
      const r = await call(relay, c);
      assert.ok(r.status >= 400 && r.status < 500, JSON.stringify(c));
      assert.equal(up.seen.length, 0);
      assert.equal(relay.stats().forwarded, 0);
      assert.equal(relay.stats().denials, 1);
    } finally { await relay.close(); await up.stop(); }
  }
});

test("a denied first request spends the run's only slot", async () => {
  const up = await fake(ok());
  const relay = await startProviderRelay(opts(up.origin));
  try {
    assert.equal((await call(relay, { body: { model: "other" } })).status, 403);
    assert.equal((await call(relay, { body: good })).status, 429);
    assert.equal(up.seen.length, 0);
    assert.equal(relay.stats().forwarded, 0);
  } finally { await relay.close(); await up.stop(); }
});

test("forwardedPort Host is accepted; other ports are not", async () => {
  const up = await fake(ok());
  const relay = await startProviderRelay(opts(up.origin, { forwardedPort: 43210 }));
  try {
    assert.equal((await call(relay, { body: good, headers: { host: "127.0.0.1:43210" } })).status, 200);
  } finally { await relay.close(); await up.stop(); }
  const up2 = await fake(ok());
  const relay2 = await startProviderRelay(opts(up2.origin, { forwardedPort: 43210 }));
  try {
    assert.equal((await call(relay2, { body: good, headers: { host: "127.0.0.1:43211" } })).status, 403);
  } finally { await relay2.close(); await up2.stop(); }
});

test("request cap: declared and chunked", async () => {
  const up = await fake(ok());
  const relay = await startProviderRelay(opts(up.origin, { maxRequestBytes: 64 }));
  const relay2 = await startProviderRelay(opts(up.origin, { maxRequestBytes: 64 }));
  try {
    const big = { model: MODEL, pad: "x".repeat(200) };
    assert.equal((await call(relay2, { body: big })).status, 413);
    const chunked = await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: relay.port, method: "POST", path: PATH, agent: false, headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
      req.on("error", reject);
      req.write("{" + " ".repeat(100));
      req.end("}");
    });
    assert.equal(chunked, 413);
    assert.equal(up.seen.length, 0);
    assert.equal(relay.stats().capDenials + relay2.stats().capDenials, 2);
  } finally { await relay.close(); await relay2.close(); await up.stop(); }
});

test("response cap yields generic error with no body", async () => {
  const up = await fake(ok("y".repeat(500)));
  const relay = await startProviderRelay(opts(up.origin, { maxResponseBytes: 100 }));
  try {
    const r = await call(relay, { body: good });
    assert.equal(r.status, 502);
    assert.equal(r.text, '{"error":"cap"}');
    assert.equal(relay.stats().capDenials, 1);
  } finally { await relay.close(); await up.stop(); }
});

test("upstream error, bad content type, redirect, and token reflection are generic", async () => {
  const cases = [
    (_q, res) => { res.writeHead(500, { "content-type": "application/json" }); res.end(`{"detail":"${TOKEN}"}`); },
    (_q, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<p>hi</p>"); },
    (_q, res) => { res.writeHead(302, { location: "/elsewhere" }); res.end(); },
    (_q, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"echo":"${TOKEN}"}`); },
  ];
  for (const h of cases) {
    const up = await fake(h);
    const relay = await startProviderRelay(opts(up.origin));
    try {
      const r = await call(relay, { body: good });
      assert.equal(r.status, 502);
      assert.equal(r.text, '{"error":"upstream"}');
      assert.ok(!r.text.includes(TOKEN));
      assert.equal(relay.stats().upstreamFailures, 1);
    } finally { await relay.close(); await up.stop(); }
  }
});

test("close aborts an in-flight upstream fetch and closes connections", async () => {
  let release;
  const up = await fake((_q, res) => { release = () => res.end("{}"); });
  const relay = await startProviderRelay(opts(up.origin));
  const pending = call(relay, { body: good }).then((r) => r, (e) => e);
  while (up.seen.length === 0) await new Promise((r) => setImmediate(r));
  const proof = await relay.close();
  assert.equal(proof.listening, false);
  assert.equal(proof.reason, "closed");
  assert.equal(proof.active, 0);
  assert.equal(relay.stats().active, 0);
  const out = await pending;
  assert.ok(out instanceof Error || out.status !== 200);
  release?.();
  await up.stop();
  assert.equal(relay.stats().active, 0);
  assert.equal(await relay.close(), proof);
});

test("deadline expiry aborts active work and marks proof expired", async () => {
  const up = await fake(() => {});
  const relay = await startProviderRelay(opts(up.origin, { deadlineMs: 50 }));
  const out = await call(relay, { body: good }).then((r) => r, (e) => e);
  assert.ok(out instanceof Error || out.status !== 200);
  const proof = await relay.close();
  assert.equal(proof.expired, true);
  assert.equal(proof.listening, false);
  await assert.rejects(call(relay, { body: good }));
  await up.stop();
});

test("caller abort closes the relay; pre-aborted signal refuses start", async () => {
  const up = await fake(ok());
  const ac = new AbortController();
  const relay = await startProviderRelay(opts(up.origin, { signal: ac.signal }));
  ac.abort();
  const proof = await relay.close();
  assert.equal(proof.reason, "aborted");
  assert.equal(proof.listening, false);
  await assert.rejects(startProviderRelay(opts(up.origin, { signal: ac.signal })));
  await up.stop();
});

test("client disconnect aborts upstream fetch", async () => {
  let upstreamClosed;
  const closed = new Promise((r) => { upstreamClosed = r; });
  const up = await fake((q) => { q.socket.on("close", upstreamClosed); });
  const relay = await startProviderRelay(opts(up.origin));
  const req = httpRequest({ host: "127.0.0.1", port: relay.port, method: "POST", path: PATH, agent: false, headers: { "content-type": "application/json" } });
  req.on("error", () => {});
  req.end(JSON.stringify(good));
  while (up.seen.length === 0) await new Promise((r) => setImmediate(r));
  req.destroy();
  await closed;
  await relay.close();
  await up.stop();
});

test("rejects missing or non-positive budgets and bad inputs", async () => {
  const o = opts("http://127.0.0.1:1");
  for (const k of ["deadlineMs", "maxRequestBytes", "maxResponseBytes"]) {
    for (const v of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "5"]) {
      await assert.rejects(startProviderRelay({ ...o, [k]: v }), TypeError);
    }
  }
  await assert.rejects(startProviderRelay({ ...o, token: "" }), TypeError);
  await assert.rejects(startProviderRelay({ ...o, model: "" }), TypeError);
  await assert.rejects(startProviderRelay({ ...o, origin: "file:///x" }), TypeError);
  for (const origin of ["http://u:p@127.0.0.1:1", "http://127.0.0.1:1/api", "http://127.0.0.1:1/?q=1", "http://127.0.0.1:1/#h"]) {
    await assert.rejects(startProviderRelay({ ...o, origin }), TypeError);
  }
  for (const forwardedPort of [0, 65536, 1.5, "80"]) {
    await assert.rejects(startProviderRelay({ ...o, forwardedPort }), TypeError);
  }
});
