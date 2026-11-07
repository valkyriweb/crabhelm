import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PI_CONTEXT_VERSION, readPiContext } from "./pi-context.mjs";

export async function runPiContextTurn({ sdkDir, configDir, contextFile, promptFile, sessionDir, model: qualified, thinking }) {
  const context = readPiContext(contextFile);
  const version = JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")).version;
  if (version !== PI_CONTEXT_VERSION) throw new Error("Pi context transport requires the pinned Pi SDK version");
  const { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(sdkDir, "dist/index.js")).href);
  const split = qualified.indexOf("/");
  if (split < 1 || !qualified.slice(split + 1)) throw new Error("Pi context transport requires a qualified model");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(configDir, "auth.json"), modelsPath: join(configDir, "models.json"),
    modelsStorePath: join(configDir, "models-store.json"), allowModelNetwork: false, refreshOnCreate: false,
  });
  const model = modelRuntime.getModel(qualified.slice(0, split), qualified.slice(split + 1));
  if (!model) throw new Error("Pi context transport model is not configured");
  const cwd = process.cwd();
  const sessionManager = SessionManager.create(cwd, sessionDir);
  for (const message of context.history) sessionManager.appendMessage(message);
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } }, cacheWarming: "off",
  });
  // No project/profile discovery, extension code, MCP, prompt templates or commands.
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => context.systemPrompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd, agentDir: configDir, model, thinkingLevel: thinking || undefined, modelRuntime,
    resourceLoader, sessionManager, settingsManager, tools: context.tools, customTools: [],
  });
  const assertTools = () => {
    const active = session.getActiveToolNames();
    const actual = session.agent.state.tools.map((tool) => tool.name);
    for (const names of [active, actual]) {
      if (names.length !== context.tools.length || new Set(names).size !== names.length || names.some((name) => !context.tools.includes(name))) throw new Error("Pi context transport tool policy mismatch");
    }
  };
  try {
    assertTools();
    // Pi's ordinary custom prompt is a preamble. Project the exact effective
    // prompt and actual allow-listed declarations at the last pre-provider seam.
    session.agent.transformContext = async (messages) => {
      assertTools();
      const toolsAdded = session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
      return [{ role: "system", content: context.systemPrompt, toolsAdded, timestamp: 0 }, ...messages.filter((message) => message.role !== "system")];
    };
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") process.stdout.write(event.assistantMessageEvent.delta);
    });
    await session.prompt(readFileSync(promptFile, "utf8"), { expandPromptTemplates: false });
    const last = [...session.messages].reverse().find((message) => message.role === "assistant");
    if (!last || ["error", "aborted", "deferred", "pending"].includes(last.stopReason)) throw new Error("Pi context transport turn did not complete");
    process.stdout.write("\n");
  } finally {
    session.dispose();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [sdkDir, configDir, contextFile, promptFile, sessionDir, model, thinking] = process.argv.slice(2);
  runPiContextTurn({ sdkDir, configDir, contextFile, promptFile, sessionDir, model, thinking }).catch(() => {
    // SDK/provider errors can contain prompts, credentials or tool arguments.
    console.error("agent-run: Pi context turn failed; inspect the private session output");
    process.exitCode = 3;
  });
}
