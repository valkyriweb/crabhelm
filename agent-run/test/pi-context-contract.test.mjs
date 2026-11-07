import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const sdkDir = process.env.AGENT_RUN_PI_TEST_SDK;
const textContent = (content) => typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text).join("");
const driver = fileURLToPath(new URL("../lib/pi-context-turn.mjs", import.meta.url));
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const priorAssistant = (content, stopReason = "stop") => ({ role: "assistant", content, stopReason, api: "openai-completions", provider: "contract", model: "context-fixture", timestamp: 2, usage: zeroUsage });
const history = [
  { role: "user", content: "PRIOR_REQUEST", timestamp: 1 },
  priorAssistant([{ type: "toolCall", id: "prior-read", name: "read", arguments: { path: "before.txt" } }], "toolUse"),
  { role: "toolResult", toolCallId: "prior-read", toolName: "read", content: [{ type: "text", text: "PRIOR_TOOL_RESULT" }], isError: false, timestamp: 3 },
  priorAssistant([{ type: "text", text: "PRIOR_REPLY" }]),
];

for (const tools of [["read"], []]) test("pinned Pi preserves context and denies out-of-policy tools: " + JSON.stringify(tools), { skip: !sdkDir && "set AGENT_RUN_PI_TEST_SDK to the pinned Pi package directory" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-context-contract-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configDir = join(dir, "config");
  const sessionDir = join(dir, "sessions");
  mkdirSync(configDir);
  writeFileSync(join(dir, "allowed.txt"), "ALLOWED_FILE_CONTENT");
  writeFileSync(join(dir, "AGENTS.md"), "MUST_NOT_APPEAR_IN_SYSTEM");
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({ defaultTools: ["bash"], appendSystemPrompt: "MUST_NOT_APPEAR_IN_SYSTEM" }));
  const marker = join(dir, "forbidden-executed");
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) => res.write("data: " + JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "context-fixture", choices: [{ index: 0, delta, finish_reason }] }) + "\n\n");
    if (requests.length === 1) {
      send({ role: "assistant", tool_calls: [
        { index: 0, id: "allowed-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "allowed.txt" }) } },
        { index: 1, id: "blocked-bash", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "touch " + JSON.stringify(marker) }) } },
      ] });
      send({}, "tool_calls");
    } else {
      send({ role: "assistant", content: "CONTEXT_OK" });
      send({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const baseUrl = "http://127.0.0.1:" + server.address().port + "/v1";
  writeFileSync(join(configDir, "models.json"), JSON.stringify({ providers: { contract: { api: "openai-completions", baseUrl, apiKey: "synthetic-contract-key", models: [{ id: "context-fixture", reasoning: false, input: ["text"] }] } } }));
  const systemPrompt = tools.length ? "EXACT SYSTEM\nNo additions.\n" : "";
  const prompt = "/literal-current-request";
  writeFileSync(join(dir, "context.json"), JSON.stringify({ version: 1, systemPrompt, tools, history }));
  writeFileSync(join(dir, "prompt.md"), prompt);
  const child = spawn(process.execPath, [driver, sdkDir, configDir, join(dir, "context.json"), join(dir, "prompt.md"), sessionDir, "contract/context-fixture", "off"], {
    cwd: dir, env: { HOME: dir, PATH: process.env.PATH, PI_CODING_AGENT_DIR: configDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /CONTEXT_OK/);
  assert.equal(requests.length, 2);
  for (const { url, body } of requests) {
    assert.equal(url, "/v1/chat/completions");
    assert.deepEqual((body.tools ?? []).map((tool) => tool.function.name), tools);
    const system = body.messages.filter((message) => ["system", "developer"].includes(message.role));
    assert.equal(system.map((message) => message.content).join(""), systemPrompt);
    assert.ok(!JSON.stringify(body).includes("MUST_NOT_APPEAR_IN_SYSTEM"));
    assert.equal(body.messages.filter((message) => message.role === "user" && textContent(message.content) === prompt).length, 1);
    for (const text of ["PRIOR_REQUEST", "PRIOR_TOOL_RESULT", "PRIOR_REPLY"]) assert.ok(JSON.stringify(body.messages).includes(text), text);
  }
  const results = requests[1].body.messages.filter((message) => message.role === "tool");
  assert.match(results.find((message) => message.tool_call_id === "blocked-bash").content, /not found|not available|unknown|not allowed/i);
  if (tools.length) assert.match(results.find((message) => message.tool_call_id === "allowed-read").content, /ALLOWED_FILE_CONTENT/);
  else assert.match(results.find((message) => message.tool_call_id === "allowed-read").content, /not found|not available|unknown|not allowed/i);
  assert.equal(existsSync(marker), false, "forbidden bash must not execute");
  const session = readdirSync(sessionDir).find((file) => file.endsWith(".jsonl"));
  const messages = readFileSync(join(sessionDir, session), "utf8").split("\n").filter(Boolean).map(JSON.parse).filter((entry) => entry.type === "message").map((entry) => entry.message);
  assert.equal(messages.filter((message) => message.role === "user" && textContent(message.content) === prompt).length, 1);
  assert.ok(messages.some((message) => message.role === "toolResult" && message.toolCallId === "blocked-bash" && message.isError));
});
