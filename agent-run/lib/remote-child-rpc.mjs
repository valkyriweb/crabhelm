// Strict JSONL RPC lifecycle controller for an ALREADY spawned, host-admitted
// pinned-fork Pi child (`pi --mode rpc`). It does not spawn, admit, capture
// profiles, relay inference, or supervise cleanup. Those remain host gates.
import { randomUUID } from "node:crypto";

export const RPC_FAIL_STOP_REASONS = Object.freeze(["error", "aborted", "length"]);

// Pinned fork 3074cdd1e: PromptDisposition = "handled" | "queued" | "started".
const PROMPT_DISPOSITIONS = Object.freeze(["started", "queued", "handled"]);

const NOT_PROVEN = Object.freeze({
  processGroupAbsence: "not_proven",
  containerAbsence: "not_proven",
  note: "cleanup, signals, and absence proofs belong to the caller supervisor",
});

function positiveInt(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer supplied by the caller`);
  }
  return value;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function badStop(message) {
  return isObject(message) && message.role === "assistant" && RPC_FAIL_STOP_REASONS.includes(message.stopReason);
}

// Required-field shapes for recognized event families, taken from the pinned
// fork 3074cdd1e: packages/agent/src/types.ts (AgentEvent) and
// packages/coding-agent/src/core/agent-session.ts (AgentSessionEvent:
// agent_end adds willRetry; agent_settled has aborted). AgentMessage is open
// (custom roles exist), so a message only needs an object with a string role;
// assistant messages additionally need a string stopReason (pi-ai
// AssistantMessage). Unrecognized event types pass through unchecked.
function validMessage(m) {
  if (!isObject(m) || typeof m.role !== "string") return false;
  if (m.role === "assistant" && typeof m.stopReason !== "string") return false;
  return true;
}
const validMessages = (a) => Array.isArray(a) && a.every(validMessage);

function eventShapeOk(e) {
  switch (e.type) {
    case "agent_end": return validMessages(e.messages) && typeof e.willRetry === "boolean";
    case "turn_end": return validMessage(e.message) && Array.isArray(e.toolResults) && e.toolResults.every(isObject);
    case "message_start":
    case "message_end": return validMessage(e.message);
    case "message_update": return validMessage(e.message) && isObject(e.assistantMessageEvent);
    case "agent_settled": return typeof e.aborted === "boolean";
    default: return true;
  }
}

function eventHasBadStop(event) {
  if (event.type === "message_end" || event.type === "turn_end") return badStop(event.message);
  if (event.type === "agent_end") return event.messages.some(badStop);
  return false;
}

/**
 * runRpcChild({ child, prompt, limits, signal, onEvent, requestId })
 *  child:   { stdin, stdout, stderr?, exitCode, signalCode, on/once } (node ChildProcess-like)
 *  prompt:  string sent via the `prompt` command
 *  limits:  { maxRecordBytes, maxOutputBytes } REQUIRED; no defaults
 *  signal:  optional AbortSignal (caller owns deadline policy)
 *  onEvent: optional async (event) => void for non-response records; awaited (backpressure)
 * Resolves (never rejects for run failures) with a structured outcome:
 *  { ok, status, reason, disposition, settled, exit:{awaited,code,signal},
 *    counts:{records,events,outputBytes,stderrBytes}, cleanup }
 * Throws TypeError only for invalid caller inputs.
 */
export function runRpcChild({ child, prompt, limits, signal, onEvent, requestId } = {}) {
  if (!child || !child.stdin || !child.stdout || typeof child.once !== "function") {
    throw new TypeError("child must expose stdin, stdout and once()");
  }
  if (typeof prompt !== "string" || prompt.length === 0) throw new TypeError("prompt must be a non-empty string");
  if (!isObject(limits)) throw new TypeError("limits are required");
  const maxRecordBytes = positiveInt(limits.maxRecordBytes, "limits.maxRecordBytes");
  const maxOutputBytes = positiveInt(limits.maxOutputBytes, "limits.maxOutputBytes");
  if (onEvent !== undefined && typeof onEvent !== "function") throw new TypeError("onEvent must be a function");
  const id = requestId ?? `rpc-${randomUUID()}`;
  if (typeof id !== "string" || id.length === 0) throw new TypeError("requestId must be a non-empty string");

  return new Promise((resolve) => {
    const counts = { records: 0, events: 0, outputBytes: 0, stderrBytes: 0 };
    const exit = { awaited: false, code: null, signal: null };
    let pending = Buffer.alloc(0);
    let queue = Promise.resolve();
    // decision is provisional until the actual child close is observed.
    // A failure is sticky; a provisional success may be downgraded to failure.
    let decision = null; // { ok, reason }
    let disposition = null;
    let responded = false;
    let settled = false;
    let closed = false;
    let finished = false;
    let stdinEnded = false;
    let releaseAbort;
    const abortP = new Promise((r) => { releaseAbort = r; });
    const decoder = new TextDecoder("utf-8", { fatal: true });

    const finish = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      releaseAbort();
      child.stdout.resume?.(); // drain and discard; no further parsing or callbacks
      resolve({
        ok: decision.ok,
        status: decision.ok ? "completed" : "failed",
        reason: decision.reason,
        disposition,
        settled,
        exit: { ...exit },
        counts: { ...counts },
        cleanup: NOT_PROVEN,
      });
    };

    const endStdin = () => {
      if (stdinEnded) return;
      stdinEnded = true;
      try { child.stdin.end(); } catch { /* exit state reports the rest */ }
    };
    const decide = (ok, reason) => {
      if (finished) return;
      if (!decision) decision = { ok, reason };
      else if (decision.ok && !ok) decision = { ok, reason };
      endStdin();
    };
    const fail = (reason) => decide(false, reason);

    const maybeComplete = () => {
      if (decision || !responded) return;
      if (disposition === "handled" || settled) decide(true, "settled");
    };

    const handleRecord = async (bytes) => {
      if (bytes.length === 0) return fail("malformed_record");
      if (bytes.length > maxRecordBytes) return fail("record_too_large");
      let rec;
      try { rec = JSON.parse(decoder.decode(bytes)); } catch { return fail("malformed_record"); }
      if (!isObject(rec) || typeof rec.type !== "string") return fail("malformed_record");
      counts.records += 1;
      if (rec.type === "response") {
        if (rec.id === undefined) return fail(rec.success === false ? "parse_error_response" : "malformed_record");
        if (rec.id !== id || responded) return fail("unexpected_response");
        if (rec.command !== "prompt") return fail("unexpected_response");
        responded = true;
        if (rec.success !== true) return fail("prompt_rejected");
        const d = isObject(rec.data) ? rec.data.disposition : undefined;
        if (!PROMPT_DISPOSITIONS.includes(d)) return fail("malformed_record");
        disposition = d;
        return maybeComplete();
      }
      counts.events += 1;
      // Shape validation precedes callbacks and lifecycle changes.
      if (!eventShapeOk(rec)) return fail("malformed_event");
      if (eventHasBadStop(rec)) return fail("assistant_failed");
      if (rec.type === "agent_settled" && rec.aborted) return fail("settled_aborted");
      if (onEvent && !finished) {
        // The wait is cancellable by abort; a late callback result or
        // rejection is swallowed. Caller-owned callback work is not cancelled.
        const cb = Promise.resolve().then(() => onEvent(rec)).then(() => true, () => false);
        const okCb = await Promise.race([cb, abortP.then(() => null)]);
        if (okCb === null || finished) return;
        if (!okCb) return fail("callback_failed");
      }
      if (rec.type === "agent_settled") { settled = true; maybeComplete(); }
    };

    // Bounds are enforced for the whole life of the child, including orderly
    // shutdown after a provisional success. After a failure is decided, further
    // output is drained and counted but not parsed.
    const handleChunk = async (chunk) => {
      if (finished) return;
      counts.outputBytes += chunk.length;
      if (counts.outputBytes > maxOutputBytes) return fail("output_too_large");
      if (decision && !decision.ok) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let start = 0;
      let nl;
      while (!finished && !(decision && !decision.ok) && (nl = pending.indexOf(0x0a, start)) !== -1) {
        let end = nl;
        if (end > start && pending[end - 1] === 0x0d) end -= 1;
        const line = pending.subarray(start, end);
        start = nl + 1;
        await handleRecord(line);
      }
      pending = pending.subarray(start);
      if (!(decision && !decision.ok) && pending.length > maxRecordBytes + 1) fail("record_too_large");
    };

    child.stdout.on("data", (chunk) => {
      if (finished) return;
      child.stdout.pause?.();
      queue = queue.then(() => handleChunk(chunk)).then(() => {
        if (!finished) child.stdout.resume?.();
      });
    });
    child.stdout.on("error", () => fail("stdout_error"));
    child.stdout.resume?.();
    if (child.stderr) {
      child.stderr.on("data", (c) => { counts.stderrBytes += c.length; }); // counted, never stored
      child.stderr.on("error", () => {});
    }
    child.stdin.on("error", () => fail("stdin_error"));
    child.once("error", () => fail("child_error"));
    child.once("close", (code, sig) => {
      closed = true;
      exit.awaited = true;
      exit.code = code ?? null;
      exit.signal = sig ?? null;
      queue.then(() => {
        if (finished) return;
        if (!(decision && !decision.ok)) {
          if (pending.length > 0) fail("unterminated_record");
          else if (!decision) fail("premature_exit");
        }
        if (decision.ok && (exit.code !== 0 || exit.signal)) fail("nonzero_exit");
        finish();
      });
    });

    // Caller abort releases the closure wait at any point, even after a
    // success or failure decision. If close was not observed, exit.awaited
    // stays false and the outcome is a failure.
    function onAbort() {
      if (finished) return;
      if (!decision || decision.ok) decision = { ok: false, reason: "aborted" };
      endStdin();
      finish();
    }
    if (signal) {
      if (signal.aborted) { decision = { ok: false, reason: "aborted" }; endStdin(); finish(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (child.exitCode != null || child.signalCode != null) {
      closed = true;
      exit.code = child.exitCode ?? null;
      exit.signal = child.signalCode ?? null;
      decision = { ok: false, reason: "premature_exit" };
      endStdin();
      finish();
      return;
    }

    // Listeners are installed above; only now send the prompt. This is ONE
    // small record handed to the stream's internal buffer; its write()
    // return value is not awaited. Only the final end() flushes/closes it.
    // This module does not stream large stdin payloads.
    try {
      child.stdin.write(JSON.stringify({ id, type: "prompt", message: prompt }) + "\n");
    } catch {
      fail("stdin_error");
    }
  });
}
