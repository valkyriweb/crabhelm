// Host-only inference auth: one invocation or sequential numbered child rounds.
// Binds loopback, fixes endpoint/model, and bounds aggregate bytes for the run.
// No donor credentials, request headers, or upstream secret headers pass through.
import { createServer } from "node:http";

const PATH = "/v1/chat/completions";
const ALLOWED_RESPONSE_TYPES = new Set(["application/json", "text/event-stream"]);

const posInt = (name, v) => {
  if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`provider-relay: ${name} must be a positive safe integer`);
  return v;
};
const mediaType = (v) => String(v ?? "").split(";")[0].trim().toLowerCase();

class Denied extends Error {
  constructor(status, key) {
    super(key);
    this.status = status;
    this.key = key;
  }
}

async function readCapped(stream, cap, onChunk) {
  const chunks = [];
  let total = 0;
  for await (const c of stream) {
    total += c.length;
    if (total > cap) throw new Denied(413, "cap");
    onChunk?.(c.length);
    chunks.push(Buffer.from(c));
  }
  return Buffer.concat(chunks, total);
}

export function startProviderRelay(options) {
  return startRelay(options, false);
}

export function startAgentProviderRelay(options) {
  return startRelay(options, true);
}

async function startRelay({ origin, model, token, deadlineMs, maxRequestBytes, maxResponseBytes, forwardedPort, signal } = {}, numberedRounds) {
  const base = new URL(origin);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new TypeError("provider-relay: origin must be http(s)");
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new TypeError("provider-relay: origin must be scheme://host[:port] only");
  }
  if (forwardedPort !== undefined && (!Number.isSafeInteger(forwardedPort) || forwardedPort < 1 || forwardedPort > 65535)) {
    throw new TypeError("provider-relay: forwardedPort must be an integer in 1..65535");
  }
  if (typeof model !== "string" || !model) throw new TypeError("provider-relay: model required");
  if (typeof token !== "string" || !token || /[\r\n\0]/.test(token)) throw new TypeError("provider-relay: invalid token");
  posInt("deadlineMs", deadlineMs);
  posInt("maxRequestBytes", maxRequestBytes);
  posInt("maxResponseBytes", maxResponseBytes);
  if (signal?.aborted) throw new Error("provider-relay: aborted before start");

  const upstreamUrl = base.origin + PATH;
  const authorization = `Bearer ${token}`;
  const tokenBytes = Buffer.from(token);
  const life = new AbortController();
  const stats = {
    attempts: 0, forwarded: 0, denials: 0, upstreamFailures: 0, capDenials: 0,
    requestBytes: 0, responseBytes: 0, active: 0, rounds: 0,
  };
  let closeReason = null;
  let closePromise = null;
  let timer = null;
  let port = 0;
  const sockets = new Set();
  const inflight = new Set();
  let slotTaken = false;
  let roundBusy = false;

  const server = createServer();
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });

  const snapshot = () => ({ ...stats, port, listening: server.listening, closed: closeReason !== null, expired: closeReason === "expired", reason: closeReason });

  const reply = (res, status, body, type = "application/json") => {
    if (res.headersSent || res.destroyed) return res.destroy();
    res.writeHead(status, { "content-type": type, "content-length": body.length, "cache-control": "no-store", connection: "close" });
    res.end(body);
  };
  const deny = (res, status, key) => {
    stats.denials += 1;
    if (key === "cap") stats.capDenials += 1;
    reply(res, status, Buffer.from(JSON.stringify({ error: key })));
  };

  async function handle(req, res) {
    stats.attempts += 1;
    // Reserve before reading a body. Numbering prevents retrying a provider
    // invocation; cumulative byte budgets still bound the whole child run.
    if (numberedRounds) {
      if (roundBusy || req.headers["x-agent-run-round"] !== String(stats.rounds + 1)) return deny(res, 409, "round");
      roundBusy = true;
    } else {
      if (slotTaken) return deny(res, 429, "round");
      slotTaken = true;
    }
    stats.rounds += 1;
    const ac = new AbortController();
    const abort = () => ac.abort();
    life.signal.addEventListener("abort", abort, { once: true });
    res.on("close", () => { if (!res.writableEnded) ac.abort(); });
    stats.active += 1;
    try {
      if (closeReason) throw new Denied(503, "closed");
      const host = String(req.headers.host ?? "");
      const ports = forwardedPort === undefined ? [port] : [port, forwardedPort];
      if (!ports.some((p) => host === `127.0.0.1:${p}` || host === `localhost:${p}`)) throw new Denied(403, "host");
      if (req.url !== PATH) throw new Denied(404, "path");
      if (req.method !== "POST") throw new Denied(405, "method");
      if (mediaType(req.headers["content-type"]) !== "application/json") throw new Denied(415, "content-type");
      if (stats.requestBytes >= maxRequestBytes || stats.responseBytes >= maxResponseBytes) throw new Denied(413, "cap");
      const declared = req.headers["content-length"];
      if (declared !== undefined && Number(declared) > maxRequestBytes - stats.requestBytes) throw new Denied(413, "cap");
      const raw = await readCapped(req, maxRequestBytes - stats.requestBytes, (n) => { stats.requestBytes += n; });
      let parsed;
      try { parsed = JSON.parse(raw.toString("utf8")); } catch { throw new Denied(400, "json"); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Denied(400, "json");
      if (parsed.model !== model) throw new Denied(403, "model");
      stats.forwarded += 1;

      let out;
      try {
        const up = await fetch(upstreamUrl, {
          method: "POST",
          redirect: "error",
          signal: ac.signal,
          headers: { "content-type": "application/json", authorization },
          body: raw,
        });
        const type = mediaType(up.headers.get("content-type"));
        if (!up.ok || !ALLOWED_RESPONSE_TYPES.has(type) || !up.body) throw new Denied(502, "upstream");
        const declaredUp = up.headers.get("content-length");
        if (!up.headers.get("content-encoding") && declaredUp !== null && Number(declaredUp) > maxResponseBytes - stats.responseBytes) throw new Denied(502, "cap");
        out = { type, body: await readCapped(up.body, maxResponseBytes - stats.responseBytes, (n) => { stats.responseBytes += n; }) };
        if (out.body.includes(tokenBytes)) throw new Denied(502, "upstream");
      } catch (e) {
        if (e instanceof Denied) {
          if (e.key === "upstream") stats.upstreamFailures += 1;
          stats.denials += 1;
          if (e.key === "cap") stats.capDenials += 1;
          return reply(res, 502, Buffer.from(JSON.stringify({ error: e.key })));
        }
        if (!ac.signal.aborted) stats.upstreamFailures += 1;
        return reply(res, 502, Buffer.from('{"error":"upstream"}'));
      }
      if (closeReason || ac.signal.aborted) return res.destroy();
      reply(res, 200, out.body, out.type);
    } catch (e) {
      if (e instanceof Denied) deny(res, e.status, e.key);
      else if (!ac.signal.aborted) deny(res, 400, "request");
      else res.destroy();
    } finally {
      stats.active -= 1;
      roundBusy = false;
      life.signal.removeEventListener("abort", abort);
    }
  }

  server.on("request", (req, res) => {
    const p = handle(req, res).catch(() => res.destroy()).finally(() => inflight.delete(p));
    inflight.add(p);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  port = server.address().port;

  const close = (reason = "closed") => {
    if (closePromise) return closePromise;
    closeReason = reason;
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
    life.abort();
    closePromise = new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const s of sockets) s.destroy();
    }).then(() => Promise.allSettled([...inflight])).then(() => snapshot());
    return closePromise;
  };
  const onCallerAbort = () => { void close("aborted"); };
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  timer = setTimeout(() => { void close("expired"); }, deadlineMs);
  timer.unref();

  return { port, close: () => close("closed"), stats: snapshot };
}
