import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readPiContext, validatePiContext } from "../lib/pi-context.mjs";

const base = () => ({ version: 1, systemPrompt: "EXACT SYSTEM\n", tools: ["read"], history: [] });
const user = { role: "user", content: "earlier", timestamp: 1 };
const assistant = (content, stopReason = "stop") => ({
  role: "assistant", content, stopReason, api: "openai-completions", provider: "contract", model: "context-fixture", timestamp: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
function sampleHistory() {
  return [user, assistant([{ type: "toolCall", id: "prior-read", name: "read", arguments: { path: "before.txt" } }], "toolUse"),
    { role: "toolResult", toolCallId: "prior-read", toolName: "read", content: [{ type: "text", text: "PRIOR_TOOL_RESULT" }], isError: false, timestamp: 3 },
    assistant([{ type: "text", text: "PRIOR_REPLY" }])];
}

test("Pi context preserves explicit empty system/tools and complete prior tool history", () => {
  const context = { ...base(), systemPrompt: "", tools: [], history: sampleHistory() };
  assert.equal(validatePiContext(context), context);
  assert.equal(context.systemPrompt, "");
  assert.deepEqual(context.tools, []);
});

test("Pi context rejects missing policy, extensions, patterns, modifiers and unsupported history", () => {
  for (const mutation of [
    { version: 2 }, { systemPrompt: undefined }, { tools: undefined }, { tools: ["read", "read"] },
    ...["codemode", "powershell", "*", "+bash", "-read", "read,bash", "Read", ""].map((name) => ({ tools: [name] })),
    { cwd: "/host" }, { extensions: [] }, { history: [{ role: "system", content: "override", timestamp: 1 }] },
    { history: [{ ...user, toolsAdded: [] }] }, { history: [{ role: "custom", content: "x", timestamp: 1 }] },
    { history: [{ ...user, timestamp: undefined }] }, { history: [{ ...user, content: [{ type: "unknown" }] }] },
    { history: [assistant([{ type: "toolCall", id: "unfinished", name: "read", arguments: {} }], "toolUse")] },
    { history: [sampleHistory()[2]] }, { history: [{ ...sampleHistory()[1], usage: undefined }] },
    { history: [{ ...sampleHistory()[3], stopReason: "deferred" }] },
    { history: [sampleHistory()[0], sampleHistory()[1], { ...sampleHistory()[2], toolName: "bash" }] },
    { history: [sampleHistory()[1], user] }, { history: [...sampleHistory(), ...sampleHistory()] },
  ]) assert.throws(() => validatePiContext({ ...base(), ...mutation }), /invalid --pi-context-file/);
});

test("Pi context parse errors do not disclose invalid input", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-context-invalid-"));
  try {
    const file = join(dir, "context.json");
    writeFileSync(file, '{"secret":"private-fixture", invalid}');
    assert.throws(() => readPiContext(file), (error) => error.message === "invalid --pi-context-file: cannot read JSON input");
    assert.ok(readFileSync(file, "utf8").includes("private-fixture"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
