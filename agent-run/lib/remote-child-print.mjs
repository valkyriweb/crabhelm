// One-shot lifecycle helper around an ALREADY spawned, host-admitted pinned-fork
// Pi CLI child run with `--print` (fork 3074cdd1e). The child does its own
// agent loop, tools, extensions and disposal; a final assistant error/aborted/
// length stop yields a nonzero exit (pinned-cli-integration.md). This helper
// parses nothing: it bounds stdout, drains stderr, feeds stdin once, and
// reports success only after the actual `close` event with exit code 0.
//
// Prompt delivery: pinned main.ts reads piped stdin to EOF (readPipedStdin) and
// merges it into the initial message, so a child with piped stdin blocks until
// stdin ends. This helper therefore ALWAYS ends stdin exactly once, optionally
// after writing the caller's `stdin` string as one buffered write (write()
// backpressure is not awaited; end() flushes). Prompt argv stays caller-owned.
//
// NOT done here: spawning, admission, process-group termination, container
// teardown. The caller supervisor MUST still do them; cleanup is "not_proven".

const CLEANUP = Object.freeze({
  processGroupAbsence: "not_proven",
  containerAbsence: "not_proven",
  note: "caller supervisor must terminate the process group and tear down the container",
});

/**
 * runPrintChild({ child, maxStdoutBytes, stdin?, signal? })
 * Resolves (never rejects for run failures) with
 *  { ok, reason, stdout: Buffer|null, exit:{awaited,code,signal},
 *    counts:{stdoutBytes,stderrBytes}, cleanup }
 * stdout is non-null only when ok. Reasons: ok | aborted | premature_exit |
 * stdout_too_large | stdin_error | stdout_error | stderr_error | child_error | nonzero_exit.
 * stderr_error: a stderr stream 'error' or a non-byte stderr chunk while active.
 * After the outcome resolves, stream errors stay swallowed by no-op handlers.
 * Throws TypeError for invalid inputs, before any listener is attached.
 */
export function runPrintChild({ child, maxStdoutBytes, stdin, signal } = {}) {
  const fn = (o, ...names) => o && names.every((n) => typeof o[n] === "function");
  if (!child || !fn(child, "on", "once", "off") || !fn(child.stdin, "on", "write", "end") ||
      !fn(child.stdout, "on", "off", "resume") ||
      (child.stderr !== undefined && child.stderr !== null && !fn(child.stderr, "on", "off", "resume"))) {
    throw new TypeError("child must expose on/once/off, stdin on/write/end, stdout on/off/resume (stderr likewise if present)");
  }
  if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes <= 0) {
    throw new TypeError("maxStdoutBytes must be a positive safe integer supplied by the caller");
  }
  if (stdin !== undefined && typeof stdin !== "string") throw new TypeError("stdin must be a string when provided");
  if (signal !== undefined && !(fn(signal, "addEventListener", "removeEventListener") && typeof signal.aborted === "boolean")) {
    throw new TypeError("signal must be an AbortSignal");
  }

  return new Promise((resolve) => {
    const counts = { stdoutBytes: 0, stderrBytes: 0 };
    const exit = { awaited: false, code: null, signal: null };
    let chunks = [];
    let failure = null; // sticky first failure reason
    let finished = false;
    let stdinEnded = false;

    const noop = () => {};
    const endStdin = () => {
      if (stdinEnded) return;
      stdinEnded = true;
      try {
        child.stdin.end();
      } catch {
        // Sticky; set directly (not via fail) to avoid fail/endStdin recursion.
        if (!failure && !finished) { failure = "stdin_error"; chunks = []; drainAll(); }
      }
    };
    const drainAll = () => {
      child.stdout.resume?.();
      child.stderr?.resume?.();
    };
    const fail = (reason) => {
      if (finished || failure) return;
      failure = reason;
      chunks = []; // never keep partial output of a failed run
      endStdin();
      drainAll();
    };

    // Bytes are counted from the moment of attachment until finish(), including
    // while discarding after a failure. After finish() (e.g. abort) the stream is
    // only drained: later bytes are neither counted nor reported.
    const onStdout = (chunk) => {
      if (finished) return;
      if (!(chunk instanceof Uint8Array)) return fail("stdout_error"); // strings/other: not a byte contract
      counts.stdoutBytes += chunk.length;
      if (failure) return;
      if (counts.stdoutBytes > maxStdoutBytes) return fail("stdout_too_large");
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    };
    const onStderr = (chunk) => { // counted only, never stored
      if (finished) return;
      if (!(chunk instanceof Uint8Array)) return fail("stderr_error");
      counts.stderrBytes += chunk.length;
    };
    const onStderrError = () => fail("stderr_error"); // no-op once finished
    const onStdoutError = () => fail("stdout_error");
    const onStdinError = () => fail("stdin_error");
    const onChildError = () => fail("child_error");

    const finish = (reason) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("close", onClose);
      child.off("error", onChildError);
      drainAll(); // streams stay flowing; errors stay swallowed below
      const ok = reason === "ok";
      const stdout = ok ? Buffer.concat(chunks) : null;
      chunks = [];
      resolve({ ok, reason, stdout, exit: { ...exit }, counts: { ...counts }, cleanup: CLEANUP });
    };

    function onClose(code, sig) {
      exit.awaited = true;
      exit.code = code ?? null;
      exit.signal = sig ?? null;
      if (failure) return finish(failure);
      if (exit.signal || exit.code !== 0) return finish("nonzero_exit");
      finish("ok");
    }
    // Abort resolves the public outcome without waiting for close.
    function onAbort() {
      if (finished) return;
      if (!failure) fail("aborted");
      finish(failure);
    }

    // Swallow late stream errors without removing anyone else's listeners.
    child.stdout.on("error", onStdoutError);
    child.stdin.on("error", onStdinError);
    child.stderr?.on("error", onStderrError);
    child.stdout.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.on("error", noop); // stays after finish so a late child 'error' is never uncaught
    child.on("error", onChildError);
    child.once("close", onClose);
    drainAll();

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    if (child.exitCode != null || child.signalCode != null) {
      exit.code = child.exitCode ?? null;
      exit.signal = child.signalCode ?? null;
      fail("premature_exit");
      finish("premature_exit");
      return;
    }
    try {
      if (stdin !== undefined && stdin.length > 0) child.stdin.write(stdin);
    } catch {
      fail("stdin_error");
      return;
    }
    endStdin();
  });
}
