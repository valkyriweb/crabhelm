import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { runPrintChild } from "../lib/remote-child-print.mjs";

function fakeChild({ onStdin, stdinWrite } = {}) {
  const c = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.exitCode = null;
  c.signalCode = null;
  c.stdinData = "";
  c.stdinEnds = 0;
  c.stdin = new Writable({
    write: stdinWrite ?? ((chunk, _e, cb) => { c.stdinData += chunk.toString(); cb(); }),
  });
  c.stdin.on("finish", () => { c.stdinEnds += 1; onStdin?.(c); });
  c.close = (code = 0, sig = null) => { c.stdout.end(); c.stderr.end(); setImmediate(() => c.emit("close", code, sig)); };
  return c;
}
const run = (child, extra = {}) => runPrintChild({ child, maxStdoutBytes: 1024, ...extra });

test("success only after close with code 0; stdin written once and ended", async () => {
  const child = fakeChild({ onStdin: (c) => { c.stdout.write("hello "); c.stdout.write("wörld"); c.close(0); } });
  const o = await run(child, { stdin: "the prompt" });
  assert.equal(o.ok, true);
  assert.equal(o.stdout.toString(), "hello wörld");
  assert.equal(child.stdinData, "the prompt");
  assert.equal(child.stdinEnds, 1);
  assert.equal(o.exit.awaited, true);
  assert.equal(o.cleanup.processGroupAbsence, "not_proven");
  assert.equal(o.cleanup.containerAbsence, "not_proven");
});

test("stdin omitted still ends stdin so the child does not block", async () => {
  const child = fakeChild({ onStdin: (c) => c.close(0) });
  const o = await run(child);
  assert.equal(o.ok, true);
  assert.equal(child.stdinData, "");
  assert.equal(child.stdinEnds, 1);
});

test("does not succeed before close even if stdout ended", async () => {
  const child = fakeChild();
  let done = false;
  const p = run(child).then((o) => { done = true; return o; });
  child.stdout.end();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false);
  child.emit("close", 0, null);
  assert.equal((await p).ok, true);
});

test("nonzero and signalled close fail with no stdout", async () => {
  for (const [code, sig] of [[1, null], [0, "SIGTERM"], [null, "SIGKILL"]]) {
    const child = fakeChild({ onStdin: (c) => { c.stdout.write("partial"); c.close(code, sig); } });
    const o = await run(child);
    assert.equal(o.ok, false);
    assert.equal(o.reason, "nonzero_exit");
    assert.equal(o.stdout, null);
    assert.equal(o.exit.awaited, true);
  }
});

test("stdout over limit fails, is counted, never truncated or returned", async () => {
  const child = fakeChild({ onStdin: (c) => { c.stdout.write("x".repeat(600)); c.stdout.write("x".repeat(600)); c.stdout.write("x".repeat(10)); c.close(0); } });
  const o = await run(child);
  assert.equal(o.ok, false);
  assert.equal(o.reason, "stdout_too_large");
  assert.equal(o.stdout, null);
  assert.ok(o.exit.awaited);
  assert.throws(() => runPrintChild({ child: fakeChild(), maxStdoutBytes: 0 }), TypeError);
  assert.throws(() => runPrintChild({ child: fakeChild() }), TypeError);
  assert.throws(() => runPrintChild({ child: fakeChild(), maxStdoutBytes: 1.5 }), TypeError);
});

test("stderr is drained and counted, never returned", async () => {
  const child = fakeChild({ onStdin: (c) => { c.stderr.write("TOPSECRET-DIAG"); c.stdout.write("ok"); c.close(0); } });
  const o = await run(child);
  assert.equal(o.ok, true);
  assert.equal(o.counts.stderrBytes, 14);
  assert.ok(!JSON.stringify(o).includes("TOPSECRET"));
});

test("stdin error fails; early-exited child fails without writing", async () => {
  const bad = fakeChild({ stdinWrite: (_c, _e, cb) => cb(new Error("EPIPE")) });
  const p = run(bad, { stdin: "x" });
  setTimeout(() => bad.close(0), 20);
  const o = await p;
  assert.equal(o.ok, false);
  assert.equal(o.reason, "stdin_error");
  const dead = fakeChild();
  dead.exitCode = 2;
  const o2 = await run(dead, { stdin: "x" });
  assert.equal(o2.reason, "premature_exit");
  assert.equal(dead.stdinData, "");
});

test("child error event fails", async () => {
  const child = fakeChild();
  const p = run(child);
  child.emit("error", new Error("spawn"));
  child.close(0);
  const o = await p;
  assert.equal(o.ok, false);
  assert.equal(o.reason, "child_error");
});

test("abort resolves without close, ends stdin, drains output, discards late output", async () => {
  const ctl = new AbortController();
  const child = fakeChild();
  const p = run(child, { signal: ctl.signal });
  child.stdout.write("some");
  ctl.abort();
  const o = await p;
  assert.equal(o.ok, false);
  assert.equal(o.reason, "aborted");
  assert.equal(o.exit.awaited, false);
  assert.equal(o.stdout, null);
  child.stdout.write("x".repeat(100000));
  child.stderr.write("y".repeat(100000));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(child.stdinEnds, 1);
  assert.equal(child.stdout.readableLength, 0);
  assert.equal(child.stderr.readableLength, 0);
  child.emit("close", 0, null); // late close must not throw
  const pre = fakeChild();
  const o2 = await run(pre, { signal: AbortSignal.abort() });
  assert.equal(o2.reason, "aborted");
  assert.equal(pre.stdinData, "");
});

test("failure waits for real close; abort releases that wait; caller listeners kept", async () => {
  const ctl = new AbortController();
  const child = fakeChild({ onStdin: (c) => c.stdout.write("x".repeat(2000)) });
  const mine = () => {};
  child.on("close", mine);
  const p = run(child, { signal: ctl.signal, stdin: "p" });
  let done = false;
  p.then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false);
  ctl.abort();
  const o = await p;
  assert.equal(o.reason, "stdout_too_large");
  assert.equal(o.exit.awaited, false);
  assert.ok(child.listeners("close").includes(mine));
  assert.equal(child.listenerCount("data"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
});

test("synchronous stdin.end() throw is sticky stdin_error even with close 0", async () => {
  const child = fakeChild();
  child.stdin.end = () => { throw new Error("end boom"); };
  const p = run(child, { stdin: "x" });
  child.stdout.write("data");
  child.close(0);
  const o = await p;
  assert.equal(o.ok, false);
  assert.equal(o.reason, "stdin_error");
  assert.equal(o.stdout, null);
  assert.equal(o.exit.awaited, true);
});

test("invalid child/signal inputs throw TypeError before any listener", () => {
  const child = fakeChild();
  const before = () => [child.listenerCount("close"), child.listenerCount("error"), child.stdout.listenerCount("data")];
  const snap = before();
  for (const bad of [
    { signal: { addEventListener() {} } },
    { signal: { addEventListener() {}, removeEventListener() {} } },
    { signal: {} },
    { stdin: 5 },
  ]) assert.throws(() => runPrintChild({ child, maxStdoutBytes: 10, ...bad }), TypeError);
  const noEnd = fakeChild(); noEnd.stdin = { on() {}, write() {} };
  assert.throws(() => run(noEnd), TypeError);
  const noOnce = fakeChild(); noOnce.once = undefined;
  assert.throws(() => run(noOnce), TypeError);
  const noOff = fakeChild(); noOff.stdout.off = undefined;
  assert.throws(() => run(noOff), TypeError);
  assert.throws(() => run(null), TypeError);
  assert.deepEqual(before(), snap);
});

test("string and non-byte stdout chunks fail as stdout_error; Uint8Array accepted", async () => {
  const s = fakeChild();
  const ps = run(s);
  s.stdout.emit("data", "héllo");
  s.close(0);
  const os = await ps;
  assert.equal(os.ok, false);
  assert.equal(os.reason, "stdout_error");
  assert.equal(os.counts.stdoutBytes, 0);
  assert.equal(os.stdout, null);
  const u = fakeChild();
  const pu = run(u);
  u.stdout.emit("data", new Uint8Array([104, 105]));
  u.stdout.emit("data", Buffer.from(" there"));
  u.close(0);
  const ou = await pu;
  assert.equal(ou.ok, true);
  assert.equal(ou.stdout.toString(), "hi there");
  assert.equal(ou.counts.stdoutBytes, 8);
});

test("stdout bytes keep being counted while discarding after a failure", async () => {
  const child = fakeChild();
  const p = run(child);
  child.stdout.write("x".repeat(1100)); // over the 1024 limit
  await new Promise((r) => setTimeout(r, 10));
  child.stdout.write("y".repeat(500));
  await new Promise((r) => setTimeout(r, 10));
  child.close(0);
  const o = await p;
  assert.equal(o.reason, "stdout_too_large");
  assert.equal(o.counts.stdoutBytes, 1600);
});

test("late stream and child errors after abort are swallowed", async () => {
  const ctl = new AbortController();
  const child = fakeChild();
  const p = run(child, { signal: ctl.signal });
  ctl.abort();
  assert.equal((await p).reason, "aborted");
  assert.doesNotThrow(() => {
    child.emit("error", new Error("late child"));
    child.stdout.emit("error", new Error("late stdout"));
    child.stderr.emit("error", new Error("late stderr"));
    child.stdin.emit("error", new Error("late stdin"));
  });
});

test("active stderr error or non-byte stderr chunk is sticky stderr_error despite close 0", async () => {
  for (const poke of [(c) => c.stderr.emit("error", new Error("e")), (c) => c.stderr.emit("data", "text")]) {
    const child = fakeChild();
    const p = run(child);
    child.stdout.write("data");
    poke(child);
    child.close(0);
    const o = await p;
    assert.equal(o.ok, false);
    assert.equal(o.reason, "stderr_error");
    assert.equal(o.stdout, null);
    assert.equal(o.exit.awaited, true);
    assert.equal(o.counts.stderrBytes, 0);
  }
});
