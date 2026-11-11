import test from "node:test";
import assert from "node:assert/strict";
import { guardRemoteBrowserCall, remoteBrowserTools, REMOTE_BROWSER_INSTRUCTIONS } from "../lib/remote-browser-policy.mjs";

const tools = () => [
  { name: "browser_open", description: "live accounts", inputSchema: { type: "object", properties: { url: { type: "string" }, import: { type: "array" } } } },
  { name: "browser_tabs", description: "Jev stats" },
  { name: "browser_jev" }, { name: "browser_import" }, { name: "browser_end" },
];
test("open always selects a throwaway agent profile without mutating caller input", () => {
  const input = { url: "https://example.com" };
  assert.deepEqual(guardRemoteBrowserCall("browser_open", input), { ...input, profile: "agent", ephemeral: true });
  assert.deepEqual(input, { url: "https://example.com" });
});
test("live/imported/unknown profiles, imports and persistent open fail closed", () => {
  for (const profile of ["live", "live:account", "imported", "LIVE", "../other", "other", null]) {
    assert.throws(() => guardRemoteBrowserCall("browser_open", { profile }), /task-owned/);
  }
  for (const args of [{ import: [] }, { import: undefined }, { ephemeral: false }]) assert.throws(() => guardRemoteBrowserCall("browser_open", args));
  assert.throws(() => guardRemoteBrowserCall("browser_tabs", { profile: "live" }));
});
test("account services and unrecognized tool names cannot reach dispatch", () => {
  for (const name of ["browser_jev", "browser_import", "browser_future_account", "__proto__"]) assert.throws(() => guardRemoteBrowserCall(name));
  for (const args of [null, [], "text"]) assert.throws(() => guardRemoteBrowserCall("browser_open", args));
});
test("normal calls preserve arguments without sharing mutable objects", () => {
  const args = { action: "click", steps: [{ ref: "e1" }] };
  const guarded = guardRemoteBrowserCall("browser_act", args);
  assert.deepEqual(guarded, args);
  guarded.steps[0].ref = "e2";
  assert.equal(args.steps[0].ref, "e1");
});
test("donor declarations remove account capabilities and replace misleading instructions", () => {
  const original = tools();
  const result = remoteBrowserTools(original);
  assert.deepEqual(result.map(t => t.name), ["browser_open", "browser_tabs", "browser_end"]);
  assert.equal(result[0].inputSchema.properties.import, undefined);
  assert.deepEqual(result[0].inputSchema.properties.profile.enum, ["agent"]);
  assert.equal(result[0].inputSchema.properties.ephemeral.const, true);
  assert.ok(original[0].inputSchema.properties.import);
  assert.doesNotMatch(result[1].description, /Jev/);
  assert.match(REMOTE_BROWSER_INSTRUCTIONS, /No live or imported/);
});
test("source drift and malformed or incomplete inventories fail closed", () => {
  for (const inventory of [null, [], [...tools(), { name: "browser_new" }], [...tools(), { name: "browser_end" }], [{ name: "browser_open" }, { name: "browser_end" }]]) {
    assert.throws(() => remoteBrowserTools(inventory));
  }
});
