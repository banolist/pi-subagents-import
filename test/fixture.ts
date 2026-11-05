import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension, { REGISTER_EVENT } from "../index.ts";
import type { AgentDefinition } from "../src/profiles.ts";

export const PROFILE = `name = "reviewer"
description = "Review project changes"
model = "gpt-example"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
developer_instructions = """
Read AGENTS.md. Проверяй поведение, не стиль.
Do not edit files.
"""
`;

export interface TestRequest {
  version: 1;
  name: string;
  definition: AgentDefinition;
  result?: { ok: true; registration: { dispose(): void } } | { ok: false; error: Error };
}

export function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-import-"));
  const project = path.join(directory, "project");
  const agentDir = path.join(directory, "agent-home");
  fs.mkdirSync(path.join(project, ".git"), { recursive: true });
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const write = (relative: string, content: string): string => {
    const file = path.join(project, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  const file = write(".codex/agents/reviewer.toml", PROFILE);
  const cleanup = (): void => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return { directory, project, agentDir, write, file, cleanup };
}

export function harness(cwd: string) {
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
  const active = new Map<string, AgentDefinition>();
  const requests: TestRequest[] = [];
  const notices: string[] = [];
  let disposed = 0;
  const state = {
    settings: { piSubagentsImport: { sandboxPolicy: "tool-policy" } } as unknown,
    trusted: true,
    owner: true,
    failAt: 0,
    emit: undefined as ((request: TestRequest) => void) | undefined,
  };
  const api = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
    registerTool() {},
    getSettings: () => state.settings,
    events: {
      emit(event: string, request: TestRequest) {
        if (event !== REGISTER_EVENT) throw new Error("Unexpected event");
        requests.push(request);
        if (state.emit) return state.emit(request);
        if (!state.owner) return;
        if (requests.length === state.failAt || active.has(request.name)) {
          request.result = { ok: false, error: new Error("Registration collision") };
          return;
        }
        active.set(request.name, request.definition);
        request.result = { ok: true, registration: { dispose() {
          if (active.get(request.name) !== request.definition) return;
          active.delete(request.name);
          disposed++;
        } } };
      },
    },
  };
  extension(api as unknown as ExtensionAPI);
  const context = {
    cwd,
    isProjectTrusted: () => state.trusted,
    ui: { notify: (text: string) => notices.push(text) },
  } as unknown as ExtensionContext;
  const fire = (event = "session_start") => handlers.get(event)!({}, context);
  return { api, state, active, requests, notices, fire, context, disposed: () => disposed };
}
