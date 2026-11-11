import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { runRpcChild } from "../lib/remote-child-rpc.mjs";

const limits = { maxRecordBytes: 4096, maxOutputBytes: 65536 };

function fakeChild({ onPrompt, autoClose = true, stdinOpts = {} } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.written = [];
  child.stdoutListenersAtWrite = null;
  child.stdinEnded = false;
  child.stdin = new Writable({
    ...stdinOpts,
    write(chunk, _enc, cb) {
      child.stdoutListenersAtWrite = child.stdout.listenerCount("data");
      const req = JSON.parse(chunk.toString());
      child.written.push(req);
      cb();
      onPrompt?.(req, child);
    },
  });
  child.stdin.on("finish", () => {
    child.stdinEnded = true;
    if (autoClose) setImmediate(() => child.close(0));
  });
  child.close = (code = 0, sig = null) => {
    child.stdout.end();
    setImmediate(() => child.emit("close", code, sig));
  };
  child.send = (obj) => child.stdout.write(typeof obj === "string" ? obj : JSON.stringify(obj) + "\n");
  return child;
}

const ok = (req, disposition = "started") => ({ id: req.id, type: "response", command: "prompt", success: true, data: { disposition } });

test("started + agent_settled completes; agent_end alone does not", async () => {
  const events = [];
  const child = fakeChild({
    onPrompt: (req, c) => {
      c.send(ok(req));
      c.send({ type: "agent_end", messages: [], willRetry: false });
      setTimeout(() => c.send({ type: "agent_settled", aborted: false }), 20);
    },
  });
  const t0 = Date.now();
  const out = await runRpcChild({ child, prompt: "hi", limits, onEvent: (e) => events.push(e.type) });
  assert.equal(out.ok, true);
  assert.equal(out.settled, true);
  assert.equal(out.disposition, "started");
  assert.ok(Date.now() - t0 >= 15);
  assert.deepEqual(events, ["agent_end", "agent_settled"]);
  assert.equal(child.stdinEnded, true);
  assert.equal(out.exit.awaited, true);
  assert.equal(out.cleanup.processGroupAbsence, "not_proven");
  assert.equal(out.cleanup.containerAbsence, "not_proven");
});

test("listeners installed before prompt is written", async () => {
  const child = fakeChild({ onPrompt: (req, c) => { c.send({ type: "agent_settled", aborted: false }); c.send(ok(req)); } });
  const out = await runRpcChild({ child, prompt: "x", limits });
  assert.ok(child.stdoutListenersAtWrite >= 1);
  assert.equal(out.ok, true); // settled before response still completes
});

test("disposition handled completes without agent_settled", async () => {
  const child = fakeChild({ onPrompt: (req, c) => c.send(ok(req, "handled")) });
  const out = await runRpcChild({ child, prompt: "/cmd", limits });
  assert.equal(out.ok, true);
  assert.equal(out.disposition, "handled");
  assert.equal(out.settled, false);
});

test("LF-only framing: CRLF, U+2028 in JSON, multibyte split across chunks", async () => {
  const seen = [];
  const child = fakeChild({
    onPrompt: (req, c) => {
      const resp = Buffer.from(JSON.stringify(ok(req)) + "\r\n");
      const ev = Buffer.from(JSON.stringify({ type: "note", text: "a\u2028b\u2029c 日本語 😀" }) + "\n");
      const settled = Buffer.from('{"type":"agent_settled","aborted":false}\n');
      const all = Buffer.concat([resp, ev, settled]);
      for (let i = 0; i < all.length; i += 3) c.stdout.write(all.subarray(i, i + 3));
    },
  });
  const out = await runRpcChild({ child, prompt: "p", limits, onEvent: (e) => seen.push(e) });
  assert.equal(out.ok, true);
  assert.equal(seen[0].text, "a\u2028b\u2029c 日本語 😀");
});

test("rejected prompt, parse-error response, unknown id", async () => {
  let o = await runRpcChild({ child: fakeChild({ onPrompt: (r, c) => c.send({ id: r.id, type: "response", command: "prompt", success: false, error: "secret detail" }) }), prompt: "p", limits });
  assert.equal(o.reason, "prompt_rejected");
  assert.ok(!JSON.stringify(o).includes("secret detail"));
  o = await runRpcChild({ child: fakeChild({ onPrompt: (_r, c) => c.send({ type: "response", success: false, error: "bad" }) }), prompt: "p", limits });
  assert.equal(o.reason, "parse_error_response");
  o = await runRpcChild({ child: fakeChild({ onPrompt: (_r, c) => c.send({ id: "other", type: "response", success: true, data: { disposition: "started" } }) }), prompt: "p", limits });
  assert.equal(o.reason, "unexpected_response");
});

test("malformed JSON, blank line, non-object, unterminated record fail", async () => {
  for (const [payload, reason] of [["not json\n", "malformed_record"], ["\n", "malformed_record"], ["[1]\n", "malformed_record"], ['{"type":"x"}', "unterminated_record"]]) {
    const child = fakeChild({ onPrompt: (_r, c) => { c.send(payload); if (reason === "unterminated_record") c.close(0); } });
    const o = await runRpcChild({ child, prompt: "p", limits });
    assert.equal(o.ok, false);
    assert.equal(o.reason, reason);
  }
});

test("premature exit and already-exited child fail", async () => {
  let o = await runRpcChild({ child: fakeChild({ onPrompt: (r, c) => { c.send(ok(r)); c.close(3); } }), prompt: "p", limits });
  assert.equal(o.reason, "premature_exit");
  assert.equal(o.exit.code, 3);
  const dead = fakeChild();
  dead.exitCode = 1;
  o = await runRpcChild({ child: dead, prompt: "p", limits });
  assert.equal(o.reason, "premature_exit");
  assert.equal(dead.written.length, 0);
});

test("assistant error/aborted/length stop reasons fail, even before agent_settled", async () => {
  for (const stopReason of ["error", "aborted", "length"]) {
    const child = fakeChild({
      onPrompt: (r, c) => {
        c.send(ok(r));
        c.send({ type: "message_end", message: { role: "assistant", stopReason, errorMessage: "SECRET-PROMPT" } });
        c.send({ type: "agent_settled", aborted: false });
      },
    });
    const o = await runRpcChild({ child, prompt: "p", limits });
    assert.equal(o.reason, "assistant_failed");
    assert.ok(!JSON.stringify(o).includes("SECRET"));
  }
  const child = fakeChild({
    onPrompt: (r, c) => {
      c.send(ok(r));
      c.send({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error" }], willRetry: false });
    },
  });
  assert.equal((await runRpcChild({ child, prompt: "p", limits })).reason, "assistant_failed");
  const fine = fakeChild({
    onPrompt: (r, c) => {
      c.send(ok(r));
      c.send({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
      c.send({ type: "agent_settled", aborted: false });
    },
  });
  assert.equal((await runRpcChild({ child: fine, prompt: "p", limits })).ok, true);
});

test("record and output limits fail rather than truncate; limits are required", async () => {
  let o = await runRpcChild({ child: fakeChild({ onPrompt: (_r, c) => c.send("x".repeat(500) + "\n") }), prompt: "p", limits: { maxRecordBytes: 100, maxOutputBytes: 10000 } });
  assert.equal(o.reason, "record_too_large");
  o = await runRpcChild({ child: fakeChild({ onPrompt: (_r, c) => c.send("x".repeat(500)) }), prompt: "p", limits: { maxRecordBytes: 100, maxOutputBytes: 10000 } });
  assert.equal(o.reason, "record_too_large");
  o = await runRpcChild({ child: fakeChild({ onPrompt: (r, c) => { c.send(ok(r)); c.send({ type: "pad", v: "y".repeat(300) }); } }), prompt: "p", limits: { maxRecordBytes: 1000, maxOutputBytes: 200 } });
  assert.equal(o.reason, "output_too_large");
  for (const bad of [undefined, {}, { maxRecordBytes: 1 }, { maxOutputBytes: 1 }, { maxRecordBytes: 0, maxOutputBytes: 1 }, { maxRecordBytes: 1.5, maxOutputBytes: 1 }]) {
    assert.throws(() => runRpcChild({ child: fakeChild(), prompt: "p", limits: bad }), TypeError);
  }
});

test("abort: pre-aborted and mid-run resolve without waiting for exit", async () => {
  const pre = AbortSignal.abort();
  const c1 = fakeChild({ autoClose: false });
  let o = await runRpcChild({ child: c1, prompt: "p", limits, signal: pre });
  assert.equal(o.reason, "aborted");
  assert.equal(c1.written.length, 0);
  const ctl = new AbortController();
  const c2 = fakeChild({ autoClose: false, onPrompt: (r, c) => { c.send(ok(r)); setTimeout(() => ctl.abort(), 10); } });
  o = await runRpcChild({ child: c2, prompt: "p", limits, signal: ctl.signal });
  assert.equal(o.reason, "aborted");
  assert.equal(o.exit.awaited, false);
  assert.equal(o.cleanup.processGroupAbsence, "not_proven");
});

test("failure waits for real exit; abort during that wait releases", async () => {
  const ctl = new AbortController();
  let closeIt;
  const child = fakeChild({ autoClose: false, onPrompt: (_r, c) => { c.send("garbage\n"); closeIt = () => c.close(9); } });
  const p = runRpcChild({ child, prompt: "p", limits, signal: ctl.signal });
  await new Promise((r) => setTimeout(r, 30));
  let done = false;
  p.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false);
  assert.equal(child.stdinEnded, true);
  closeIt();
  const o = await p;
  assert.equal(o.reason, "malformed_record");
  assert.equal(o.exit.awaited, true);
  assert.equal(o.exit.code, 9);
});

test("callback failure fails; backpressure pauses stdout while callback pending", async () => {
  let o = await runRpcChild({ child: fakeChild({ onPrompt: (r, c) => { c.send(ok(r)); c.send({ type: "e" }); } }), prompt: "p", limits, onEvent: () => { throw new Error("SECRET"); } });
  assert.equal(o.reason, "callback_failed");
  assert.ok(!JSON.stringify(o).includes("SECRET"));
  let release;
  let paused = false;
  const child = fakeChild({ onPrompt: (r, c) => { c.send(ok(r)); c.send({ type: "e" }); c.send({ type: "agent_settled", aborted: false }); } });
  const p = runRpcChild({ child, prompt: "p", limits, onEvent: (e) => e.type === "e" ? new Promise((r) => { release = r; setImmediate(() => { paused = child.stdout.isPaused(); }); }) : undefined });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(paused, true);
  release();
  o = await p;
  assert.equal(o.ok, true);
  assert.equal(o.counts.events, 2);
});

test("stdin write error and stderr is counted, not stored", async () => {
  const child = fakeChild({ onPrompt: (r, c) => { c.stderr.write("TOPSECRET"); c.send(ok(r, "handled")); } });
  const o = await runRpcChild({ child, prompt: "p", limits });
  assert.equal(o.ok, true);
  assert.ok(o.counts.stderrBytes >= 0);
  assert.ok(!JSON.stringify(o).includes("TOPSECRET"));
  const bad = fakeChild({ autoClose: false });
  bad.stdin = new Writable({ write(_c, _e, cb) { cb(new Error("boom")); } });
  const p = runRpcChild({ child: bad, prompt: "p", limits });
  setTimeout(() => bad.close(1), 30);
  assert.equal((await p).reason, "stdin_error");
});

test("provisional success downgrades on nonzero or signalled close", async () => {
  for (const [code, sig] of [[7, null], [0, "SIGKILL"]]) {
    const child = fakeChild({ autoClose: false, onPrompt: (r, c) => { c.send(ok(r, "handled")); setTimeout(() => c.close(code, sig), 10); } });
    const o = await runRpcChild({ child, prompt: "p", limits });
    assert.equal(o.ok, false);
    assert.equal(o.reason, "nonzero_exit");
    assert.equal(o.exit.awaited, true);
  }
});

test("abort during closure wait after success or failure decision", async () => {
  for (const payload of ["ok", "bad"]) {
    const ctl = new AbortController();
    const seen = [];
    const child = fakeChild({
      autoClose: false,
      onPrompt: (r, c) => {
        if (payload === "ok") c.send(ok(r, "handled")); else c.send("garbage\n");
        setTimeout(() => ctl.abort(), 15);
        setTimeout(() => c.send({ type: "late" }), 40);
      },
    });
    const o = await runRpcChild({ child, prompt: "p", limits, signal: ctl.signal, onEvent: (e) => seen.push(e.type) });
    assert.equal(o.ok, false);
    assert.equal(o.exit.awaited, false);
    assert.equal(o.reason, payload === "ok" ? "aborted" : "malformed_record");
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(seen, []); // nothing reported after resolved abort
  }
});

test("bounds and invalid records after provisional success never yield ok", async () => {
  const cases = [
    ["output", (c) => c.send({ type: "pad", v: "z".repeat(400) }), { maxRecordBytes: 1000, maxOutputBytes: 200 }, "output_too_large"],
    ["record", (c) => c.send("x".repeat(300) + "\n"), { maxRecordBytes: 100, maxOutputBytes: 100000 }, "record_too_large"],
    ["garbage", (c) => c.send("nope\n"), limits, "malformed_record"],
    ["assistant", (c) => c.send({ type: "message_end", message: { role: "assistant", stopReason: "error" } }), limits, "assistant_failed"],
    ["partial", (c) => c.send('{"type":"x"'), limits, "unterminated_record"],
  ];
  for (const [, extra, lim, reason] of cases) {
    const child = fakeChild({ autoClose: false, onPrompt: (r, c) => { c.send(ok(r, "handled")); extra(c); setTimeout(() => c.close(0), 20); } });
    const o = await runRpcChild({ child, prompt: "p", limits: lim });
    assert.equal(o.ok, false, reason);
    assert.equal(o.reason, reason);
  }
});

test("response must be command prompt with pinned disposition", async () => {
  const bads = [
    (r) => ({ id: r.id, type: "response", command: "steer", success: true, data: { disposition: "queued" } }),
    (r) => ({ id: r.id, type: "response", success: true, data: { disposition: "started" } }),
    (r) => ({ id: r.id, type: "response", command: "prompt", success: true, data: { disposition: "weird" } }),
    (r) => ({ id: r.id, type: "response", command: "prompt", success: true, data: {} }),
  ];
  for (const mk of bads) {
    const o = await runRpcChild({ child: fakeChild({ onPrompt: (r, c) => c.send(mk(r)) }), prompt: "p", limits });
    assert.equal(o.ok, false);
  }
  const q = fakeChild({ onPrompt: (r, c) => { c.send(ok(r, "queued")); c.send({ type: "agent_settled", aborted: false }); } });
  const o = await runRpcChild({ child: q, prompt: "p", limits });
  assert.equal(o.ok, true);
  assert.equal(o.disposition, "queued");
});

test("malformed recognized events fail before callbacks, active and trailing", async () => {
  const asst = { role: "assistant", stopReason: "stop" };
  const bad = [
    { type: "message_end", message: null },
    { type: "message_end" },
    { type: "message_start", message: { role: 5 } },
    { type: "message_update", message: asst },
    { type: "turn_end", message: asst },
    { type: "turn_end", message: asst, toolResults: [1] },
    { type: "agent_end", messages: [null], willRetry: false },
    { type: "agent_end", messages: [], },
    { type: "agent_end", messages: [{ role: "assistant" }], willRetry: false },
    { type: "agent_settled" },
  ];
  for (const ev of bad) {
    // active: before settlement
    let seen = [];
    let child = fakeChild({ onPrompt: (r, c) => { c.send(ok(r)); c.send(ev); c.send({ type: "agent_settled", aborted: false }); } });
    let o = await runRpcChild({ child, prompt: "p", limits, onEvent: (e) => seen.push(e) });
    assert.equal(o.ok, false, JSON.stringify(ev));
    assert.equal(o.reason, "malformed_event");
    assert.ok(!seen.some((e) => e === ev || e.type === ev.type && e.type !== "agent_settled"));
    // trailing shutdown: after provisional success
    child = fakeChild({ autoClose: false, onPrompt: (r, c) => { c.send(ok(r, "handled")); c.send(ev); setTimeout(() => c.close(0), 15); } });
    o = await runRpcChild({ child, prompt: "p", limits });
    assert.equal(o.ok, false, JSON.stringify(ev));
    assert.equal(o.reason, "malformed_event");
  }
  const good = fakeChild({ onPrompt: (r, c) => { c.send(ok(r)); c.send({ type: "message_end", message: { role: "custom" } }); c.send({ type: "unknown_future" }); c.send({ type: "agent_settled", aborted: false }); } });
  assert.equal((await runRpcChild({ child: good, prompt: "p", limits })).ok, true);
  const ab = fakeChild({ onPrompt: (r, c) => { c.send(ok(r)); c.send({ type: "agent_settled", aborted: true }); } });
  assert.equal((await runRpcChild({ child: ab, prompt: "p", limits })).reason, "settled_aborted");
});

test("abort during pending callback releases wait, drains stdout, no further callbacks", async () => {
  for (const lateResult of ["resolve", "reject"]) {
    const ctl = new AbortController();
    const seen = [];
    let settleCb;
    const child = fakeChild({ autoClose: false, onPrompt: (r, c) => { c.send(ok(r)); c.send({ type: "e1" }); c.send({ type: "e2" }); } });
    const p = runRpcChild({
      child, prompt: "p", limits, signal: ctl.signal,
      onEvent: (e) => { seen.push(e.type); return new Promise((res, rej) => { settleCb = lateResult === "resolve" ? res : () => rej(new Error("late")); }); },
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(child.stdout.isPaused(), true);
    ctl.abort();
    const o = await p;
    assert.equal(o.reason, "aborted");
    assert.equal(o.exit.awaited, false);
    assert.equal(child.stdout.isPaused(), false);
    settleCb();
    child.send({ type: "trailing" });
    child.send("garbage\n");
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(seen, ["e1"]);
    assert.equal(child.stdout.readableLength, 0);
  }
});
