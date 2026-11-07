import { readFileSync } from "node:fs";

// This transport carries stock Linux Pi tools, not extension tools or replacements.
export const PI_CONTEXT_VERSION = "1.5.0";
export const PI_CONTEXT_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const finite = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const fail = (reason) => { throw new Error("invalid --pi-context-file: " + reason); };

function content(blocks, allowed) {
  if (!Array.isArray(blocks)) fail("message content must be an array");
  for (const block of blocks) {
    if (!object(block) || !allowed.includes(block.type)) fail("unsupported message content block");
    if (block.type === "text" && typeof block.text !== "string") fail("text block must contain text");
    if (block.type === "image" && (typeof block.data !== "string" || typeof block.mimeType !== "string")) fail("image block must contain data and mimeType");
    if (block.type === "thinking" && typeof block.thinking !== "string" && !(block.redacted === true && typeof block.thinkingSignature === "string")) fail("thinking block must contain thinking or a redacted signature");
    if (block.type === "toolCall" && (typeof block.id !== "string" || !block.id || typeof block.name !== "string" || !block.name || !object(block.arguments))) fail("tool call must contain id, name and arguments");
  }
}

function usage(value) {
  if (!object(value) || !["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => finite(value[key])) ||
    !object(value.cost) || !["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => finite(value.cost[key]))) fail("assistant usage is required");
}

export function validatePiContext(value) {
  if (!object(value) || value.version !== 1 || typeof value.systemPrompt !== "string" || !Array.isArray(value.tools) || !Array.isArray(value.history)) fail("expected version 1, systemPrompt, tools and history");
  if (Object.keys(value).some((key) => !["version", "systemPrompt", "tools", "history"].includes(key))) fail("unsupported context field");
  if (value.tools.some((name) => !PI_CONTEXT_TOOLS.includes(name)) || new Set(value.tools).size !== value.tools.length) fail("tools must be unique exact stock Linux Pi tool names; use local execution for custom tools");
  const pending = new Map();
  const seen = new Set();
  for (const message of value.history) {
    if (!object(message) || !finite(message.timestamp)) fail("history requires message timestamps");
    if (["sections", "toolsAdded", "toolsRemoved"].some((key) => key in message)) fail("history must not change system instructions or tools");
    if (message.role === "user") {
      if (pending.size) fail("history contains unresolved tool calls");
      if (typeof message.content !== "string") content(message.content, ["text", "image"]);
    } else if (message.role === "assistant") {
      if (pending.size) fail("history contains unresolved tool calls");
      if (!["api", "provider", "model"].every((key) => typeof message[key] === "string") || !["stop", "length", "toolUse", "error", "aborted"].includes(message.stopReason)) fail("history requires completed Pi assistant messages");
      usage(message.usage);
      content(message.content, ["text", "thinking", "toolCall"]);
      for (const block of message.content.filter((block) => block.type === "toolCall")) {
        if (seen.has(block.id)) fail("history contains duplicate tool-call ids");
        seen.add(block.id);
        pending.set(block.id, block.name);
      }
    } else if (message.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || !pending.has(message.toolCallId) || pending.get(message.toolCallId) !== message.toolName || typeof message.isError !== "boolean") fail("history contains an unpaired tool result");
      content(message.content, ["text", "image"]);
      pending.delete(message.toolCallId);
    } else {
      fail("unsupported history role; supply normalized non-system Pi messages or use local execution");
    }
  }
  if (pending.size) fail("history contains unresolved tool calls");
  return value;
}

export function readPiContext(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("cannot read JSON input"); }
  return validatePiContext(value);
}
