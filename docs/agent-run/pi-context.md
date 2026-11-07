# Pi child-context transport

Use --pi-context-file FILE with --harness pi --model PROVIDER/MODEL to carry a supported child's effective system prompt, exact tool selection and prior messages. This is an opt-in remote transport. Existing prompt-only calls keep their existing behavior.

~~~sh
agent-run --harness pi --model clawrouter/claude-sonnet-5-5-200k --prompt-file current.md --pi-context-file child-context.json --placement remote --out private-result
~~~

## Input contract

~~~json
{
  "version": 1,
  "systemPrompt": "The child's complete current effective system prompt.",
  "tools": ["read"],
  "history": [
    { "role": "user", "content": "Earlier request", "timestamp": 1 }
  ]
}
~~~

All four fields are required. An empty system prompt and an empty tool list are valid. Missing fields never enable defaults. Unknown context fields are rejected.

- **systemPrompt** is the complete current effective prompt, not a preamble or a delta. Pi's normal generated prompt, cwd section, project instructions and append prompts do not reach the provider.
- **tools** contains unique, exact, unmodified stock Linux Pi tool names: read, bash, edit, write, grep, find, ls. Extensions, overridden built-ins, MCP tools, PowerShell, modifiers and patterns are not supported. Do not represent a restricted replacement tool as the stock built-in with the same name.
- **history** contains ordered, normalized, non-system Pi messages: user, completed assistant, and paired toolResult. Preserve assistant model/API metadata, usage, content blocks, signatures and tool-call IDs. Calls and results must be complete and paired. System/tool updates, custom roles, compaction entries and deferred results are rejected, not silently discarded. The caller must first resolve effective system/tool state and normalize supported history, or keep the child local.
- The current prompt belongs **only** in --prompt-file, not in history. The driver calls session.prompt() once. Prompt-template expansion is disabled, including for slash-prefixed text.

This transport does not copy the caller's workspace, cwd, extensions, custom tool implementations, queued steering messages or extension callbacks. Remote tools operate inside the disposable run's inputs directory. A caller that depends on those unsupported capabilities must keep its existing local session. Matching a tool name alone does not establish tool-implementation equivalence. The tool allow-list is not an operating-system sandbox; allowing bash permits shell execution and access to the per-run CLAWROUTER_API_KEY. The normal cleanup revokes that key.

## Enforcement and failure behavior

The adapter uses the appliance's pinned @earendil-works/pi-coding-agent@1.5.0 SDK. The native CLI's --system-prompt is only a preamble and cannot preserve an exact prompt, especially an empty one. The per-run SDK driver uses an empty resource loader, explicit tool names, no custom tools, and in-memory settings with compaction, retries and cache warming disabled. It does not load profile/project extensions, MCP, skills, prompt templates, context files or settings.

The driver restores prior messages through SessionManager. Before every provider request it verifies the actual active tool set against the allow-list. It projects one exact system message with declarations from those actual tools. Pi's execution registry also contains only allowed tools, so an out-of-list model call returns an error rather than executing. The driver checks the installed SDK version before importing it. Unsupported appliance pins fail before resource acquisition.

Invalid input fails before placement, key minting or lease creation. A local placement with supplied context also fails without invoking Pi; the caller must continue its original local session. No tool policy or history is silently dropped to make a run fit. Generic driver errors do not print prompt, tool arguments or provider diagnostics.

The context and trusted driver files travel in the private per-run configuration, never the reusable appliance/cache. Staging is removed by the normal run cleanup. The normal returned session contains the supplied prior conversation and new messages; SDK-generated system bookkeeping is not a wire-level recording of the final prompt projection. Receipts contain only context version, SDK version, tool names and history count, not the prompt/history body. Treat all session/stdout artifacts as private. Existing key revocation and lease cleanup still apply on driver failure.

## Verification

pnpm agent-run:test runs the dependency-free validation and transport tests. To include the actual pinned-SDK contract locally, set AGENT_RUN_PI_TEST_SDK to an **existing** Pi 1.5.0 package directory. This does not update either installed Pi runtime. CI prepares a separate pinned fixture with install scripts disabled and runs the contract as part of pnpm check.

The deterministic contract runs only against a loopback HTTP fake API. It checks the serialized system prompt, history, tool declarations and exactly one current prompt across a tool turn. It returns both an allowed read and a forbidden bash call. The test proves that read works when allowed, both calls fail for an empty policy, and forbidden bash never creates its marker file. It also checks that project instructions and saved defaults cannot widen the policy. This is not a live-provider or off-laptop acceptance receipt.

The my-pi hook remains safe-local until a separate hook-enablement change consumes this contract. Reflection acceptance still requires both slices to be merged and installed.
