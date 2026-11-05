import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { fixture, harness, PROFILE } from "./fixture.ts";

const ownerRoot = process.env.PI_SUBAGENTS_ROOT;

test("public event works with a stock owner, operator overrides and session cleanup", {
  skip: !ownerRoot && "Set PI_SUBAGENTS_ROOT to an installed pi-subagents package",
}, async () => {
  const f = fixture();
  const h = harness(f.project);
  const events = await import(pathToFileURL(path.join(ownerRoot!, "src/agents/runtime-agent-events.js")).href);
  const registry = await import(pathToFileURL(path.join(ownerRoot!, "src/agents/runtime-agent-registry.js")).href);
  let listener: ((request: unknown) => void) | undefined;
  const owner = {
    on() {}, registerTool() {},
    events: { on(_event: string, handler: (request: unknown) => void) { listener = handler; return () => { listener = undefined; }; } },
  };
  const unsubscribe = events.registerRuntimeAgentEventListener(owner);
  h.state.emit = (request) => listener!(request);
  try {
    f.write(".pi/settings.json", JSON.stringify({ subagents: { agentOverrides: { "codex.reviewer": { model: "provider/alternate", thinking: "medium" } } } }));
    h.fire();
    const registered = registry.listRuntimeAgentConfigs(owner);
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "codex.reviewer");
    assert.deepEqual(registered[0].tools, ["read", "grep", "find", "ls"]);
    const merged = registry.mergeRuntimeAgents(owner, { agents: [] }, [], { cwd: f.project, scope: "project" });
    assert.equal(merged.agents[0].model, "provider/alternate");
    assert.equal(merged.agents[0].thinking, "medium");
    assert.deepEqual(merged.agents[0].tools, ["read", "grep", "find", "ls"]);
    assert.equal(fs.readFileSync(f.file, "utf8"), PROFILE);
    assert.throws(() => registry.mergeRuntimeAgents(owner, { agents: [registered[0]] }), /collides with configured agent/);
    h.fire("session_shutdown");
    assert.equal(registry.listRuntimeAgentConfigs(owner).length, 0);
    h.fire();
    assert.equal(registry.listRuntimeAgentConfigs(owner).length, 1);
    fs.unlinkSync(f.file);
    h.fire();
    assert.equal(registry.listRuntimeAgentConfigs(owner).length, 0);
    assert.equal(fs.existsSync(path.join(f.project, ".pi/agents")), false);
  } finally {
    h.fire("session_shutdown");
    registry.clearRuntimeAgentsForPi(owner);
    unsubscribe();
    f.cleanup();
  }
});

test("a stock owner collision rolls back only this package's registrations", {
  skip: !ownerRoot && "Set PI_SUBAGENTS_ROOT to an installed pi-subagents package",
}, async () => {
  const f = fixture();
  const h = harness(f.project);
  const events = await import(pathToFileURL(path.join(ownerRoot!, "src/agents/runtime-agent-events.js")).href);
  const registry = await import(pathToFileURL(path.join(ownerRoot!, "src/agents/runtime-agent-registry.js")).href);
  let listener: ((request: unknown) => void) | undefined;
  const owner = {
    on() {}, registerTool() {},
    events: { on(_event: string, handler: (request: unknown) => void) { listener = handler; return () => { listener = undefined; }; } },
  };
  const unsubscribe = events.registerRuntimeAgentEventListener(owner);
  const existing = registry.registerRuntimeAgent({ pi: owner, name: "codex.worker", definition: { description: "Existing role", systemPrompt: "Keep this role." } });
  h.state.emit = (request) => listener!(request);
  try {
    f.write(".codex/agents/worker.toml", PROFILE.replace('name = "reviewer"', 'name = "worker"'));
    assert.throws(() => h.fire(), /collides with runtime agent/);
    assert.deepEqual(registry.listRuntimeAgentConfigs(owner).map((agent: { name: string }) => agent.name), ["codex.worker"]);
    h.fire("session_shutdown");
    assert.equal(registry.listRuntimeAgentConfigs(owner).length, 1);
  } finally {
    existing.dispose();
    registry.clearRuntimeAgentsForPi(owner);
    unsubscribe();
    f.cleanup();
  }
});
