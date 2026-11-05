import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { collectProfiles, findProjectRoot } from "../src/discovery.ts";
import { parseProfile } from "../src/profiles.ts";
import { fixture, harness, PROFILE } from "./fixture.ts";

describe("pi-subagents-import", () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { f = fixture(); });
  afterEach(() => f.cleanup());

  it("maps the source into a namespaced native runtime definition", () => {
    const profile = parseProfile(PROFILE, f.file, "tool-policy");
    assert.equal(profile.name, "codex.reviewer");
    assert.equal(profile.definition.model, "gpt-example");
    assert.equal(profile.definition.thinking, "high");
    assert.equal(profile.definition.systemPrompt, "Read AGENTS.md. Проверяй поведение, не стиль.\nDo not edit files.");
    assert.equal(profile.definition.systemPromptMode, "append");
    assert.equal(profile.definition.inheritProjectContext, true);
    assert.equal(profile.definition.inheritGlobalContext, false);
    assert.equal(profile.definition.inheritSkills, true);
    assert.deepEqual(profile.definition.tools, ["read", "grep", "find", "ls"]);
    assert.deepEqual(profile.definition.extensions, []);
    assert.deepEqual(profile.definition.subagentOnlyExtensions, []);
    assert.equal(profile.definition.allowNestedSubagents, false);
  });

  it("requires sandbox acknowledgement and leaves writers without fake isolation", () => {
    assert.throws(() => parseProfile(PROFILE, f.file, "reject"), /not an OS sandbox/);
    const writer = parseProfile(PROFILE.replace("read-only", "workspace-write").replace('"high"', '"none"'), f.file, "tool-policy");
    assert.equal(writer.definition.tools, undefined);
    assert.equal(writer.definition.thinking, "off");
    const inherited = parseProfile('name="worker"\ndescription="Work"\ndeveloper_instructions="Implement."', f.file, "reject");
    assert.equal(inherited.definition.tools, undefined);
    assert.equal(inherited.definition.model, undefined);
    assert.equal(inherited.definition.thinking, undefined);
    assert.equal(inherited.declaresSandbox, false);
  });

  it("rejects malformed or unsupported inputs without echoing parser source", () => {
    for (const content of [
      PROFILE + '[mcp_servers.test]\ncommand="server"',
      PROFILE + 'approval_policy="never"',
      PROFILE.replace('"read-only"', '"danger-full-access"'),
      PROFILE.replace('"high"', '"invalid"'),
      PROFILE.replace('name = "reviewer"', 'name = "../reviewer"'),
      PROFILE.replace('model = "gpt-example"', 'model = 42'),
      PROFILE.replace('description = "Review project changes"', 'description = ""'),
      PROFILE.replace('developer_instructions = """', 'developer_instructions = ""\n#'),
      PROFILE + 'name="duplicate"',
    ]) assert.throws(() => parseProfile(content, f.file, "tool-policy"));
    assert.throws(() => parseProfile('name="UNFINISHED_SECRET', f.file, "tool-policy"), (error: Error) => {
      assert.match(error.message, /Invalid TOML/);
      assert.doesNotMatch(error.message, /UNFINISHED_SECRET/);
      return true;
    });
  });

  it("registers without source writes or generated files", () => {
    const h = harness(f.project);
    h.fire();
    assert.deepEqual([...h.active.keys()], ["codex.reviewer"]);
    assert.equal(h.requests[0].version, 1);
    assert.equal(fs.readFileSync(f.file, "utf8"), PROFILE);
    assert.equal(fs.existsSync(path.join(f.project, ".pi")), false);
    assert.ok(h.notices.some((message) => message.includes("NOT an OS sandbox")));
    h.fire("session_shutdown");
    h.fire("session_shutdown");
    assert.equal(h.active.size, 0);
    assert.equal(h.disposed(), 1);
  });

  it("reregisters edits and removes deleted roles at the next session start", () => {
    const h = harness(f.project);
    h.fire();
    f.write(".codex/agents/reviewer.toml", PROFILE.replace("Review project changes", "Updated role"));
    assert.equal(h.active.get("codex.reviewer")?.description, "Review project changes");
    h.fire();
    assert.equal(h.active.get("codex.reviewer")?.description, "Updated role");
    fs.unlinkSync(f.file);
    h.fire();
    assert.equal(h.active.size, 0);
  });

  it("removes stale registrations if a later reload contains invalid input", () => {
    const h = harness(f.project);
    h.fire();
    f.write(".codex/agents/reviewer.toml", "invalid TOML!");
    assert.throws(() => h.fire(), /Invalid TOML/);
    assert.equal(h.active.size, 0);
  });

  it("checks trust before paths, settings, or profile reads", () => {
    const h = harness("/a/path/that/does/not/exist");
    h.state.trusted = false;
    h.state.settings = { piSubagentsImport: "invalid" };
    assert.doesNotThrow(() => h.fire());
    assert.equal(h.requests.length, 0);
    const trusted = harness(f.project);
    trusted.fire();
    trusted.state.trusted = false;
    trusted.fire();
    assert.equal(trusted.active.size, 0);
  });

  it("stays inert in native child processes where the parent owner is absent", () => {
    const old = process.env.PI_SUBAGENT_CHILD;
    try {
      process.env.PI_SUBAGENT_CHILD = "1";
      const h = harness("/a/path/that/does/not/exist");
      h.state.owner = false;
      assert.doesNotThrow(() => h.fire());
      assert.equal(h.requests.length, 0);
    } finally {
      if (old === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = old;
    }
  });

  it("rejects invalid package config and uses reject as the default policy", () => {
    const h = harness(f.project);
    for (const config of [{}, { piSubagentsImport: {} }]) {
      h.state.settings = config;
      assert.throws(() => h.fire(), /sandbox_mode requires/);
    }
    for (const config of [true, { sandboxPolicy: true }, { sandboxPolicy: "unsafe" }, { unknown: true }]) {
      h.state.settings = { piSubagentsImport: config };
      assert.throws(() => h.fire(), /piSubagentsImport/);
    }
    assert.equal(h.requests.length, 0);
  });

  it("fails visibly without a compatible owner and rolls back a failed registration batch", () => {
    const missing = harness(f.project);
    missing.state.owner = false;
    assert.throws(() => missing.fire(), /pi-subagents is not ready/);
    f.write(".codex/agents/worker.toml", PROFILE.replace('name = "reviewer"', 'name = "worker"'));
    const h = harness(f.project);
    h.state.failAt = 2;
    assert.throws(() => h.fire(), /collision/);
    assert.equal(h.active.size, 0);
    assert.equal(h.disposed(), 1);
  });

  it("validates the complete source batch before registering any role", () => {
    f.write(".codex/agents/z-invalid.toml", "invalid TOML!");
    const h = harness(f.project);
    assert.throws(() => h.fire(), /Invalid TOML/);
    assert.equal(h.requests.length, 0);
    fs.unlinkSync(path.join(f.project, ".codex/agents/z-invalid.toml"));
    f.write(".codex/agents/duplicate.toml", PROFILE);
    assert.throws(() => h.fire(), /Duplicate Codex role/);
    assert.equal(h.requests.length, 0);
  });

  it("honors project-relative exclusions before reading invalid files", () => {
    f.write(".codex/agents/ignored/invalid.toml", "invalid");
    f.write(".codex/agents/ignored-other/worker.toml", PROFILE.replace('name = "reviewer"', 'name = "worker"'));
    f.write(".pi/settings.json", JSON.stringify({ subagents: { agentExcludeDirs: ["../.codex/agents/ignored"] } }));
    const profiles = collectProfiles(f.project, f.agentDir, "tool-policy");
    assert.deepEqual(profiles.map((profile) => profile.name), ["codex.reviewer", "codex.worker"]);
  });

  it("honors user exclusions, including canonical paths through an alias", () => {
    const alias = path.join(f.directory, "alias");
    fs.symlinkSync(path.join(f.project, ".codex"), alias, "dir");
    fs.mkdirSync(f.agentDir, { recursive: true });
    fs.writeFileSync(path.join(f.agentDir, "settings.json"), JSON.stringify({ subagents: { agentExcludeDirs: [alias] } }));
    const h = harness(f.project);
    h.fire();
    assert.equal(h.requests.length, 0);
  });

  it("fails closed on malformed settings and exclusions", () => {
    for (const content of ["{", "null", JSON.stringify({ subagents: { agentExcludeDirs: "../.codex" } })]) {
      f.write(".pi/settings.json", content);
      assert.throws(() => harness(f.project).fire(), /settings|agentExcludeDirs/i);
    }
  });

  it("does not cross a nested Git boundary or import personal home profiles", () => {
    const nested = path.join(f.project, "nested");
    fs.mkdirSync(path.join(nested, ".git"), { recursive: true });
    assert.equal(findProjectRoot(nested), nested);
    const h = harness(nested);
    h.fire();
    assert.equal(h.requests.length, 0);
    assert.equal(findProjectRoot(os.homedir()), undefined);
  });

  it("supports Git worktree files and non-Git projects from nested cwd", () => {
    fs.rmSync(path.join(f.project, ".git"), { recursive: true });
    const cwd = path.join(f.project, "src/feature");
    fs.mkdirSync(cwd, { recursive: true });
    assert.equal(findProjectRoot(cwd), f.project);
    f.write(".git", "gitdir: /not-needed-for-discovery");
    assert.equal(findProjectRoot(cwd), f.project);
  });

  it("refuses symlinked sources rather than reading outside the project", () => {
    const outside = path.join(f.directory, "outside.toml");
    fs.writeFileSync(outside, PROFILE);
    fs.unlinkSync(f.file);
    fs.symlinkSync(outside, f.file);
    assert.throws(() => harness(f.project).fire(), /Symlinks/);
    fs.rmSync(path.join(f.project, ".codex"), { recursive: true });
    fs.symlinkSync(f.directory, path.join(f.project, ".codex"), "dir");
    assert.throws(() => harness(f.project).fire(), /non-symlink/);
  });

  it("bounds profile bytes and the runtime profile count", () => {
    fs.writeFileSync(f.file, "#".repeat(1024 * 1024 + 1));
    assert.throws(() => harness(f.project).fire(), /limit exceeded/);
    fs.unlinkSync(f.file);
    for (let i = 0; i < 201; i++) f.write(`.codex/agents/role-${i}.toml`, PROFILE.replace('name = "reviewer"', `name = "role-${i}"`));
    assert.throws(() => harness(f.project).fire(), /limit exceeded/);
  });
});
