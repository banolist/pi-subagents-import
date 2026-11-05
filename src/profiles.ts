import { parse } from "smol-toml";

export type SandboxPolicy = "reject" | "tool-policy";

// Structural subset of the public runtime registration event; no runtime import of pi-subagents.
export interface AgentDefinition {
  description: string;
  systemPrompt: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  extensions?: string[];
  subagentOnlyExtensions?: string[];
  allowNestedSubagents?: boolean;
  systemPromptMode: "append";
  inheritProjectContext: true;
  inheritGlobalContext: false;
  inheritSkills: true;
}

export interface Profile {
  name: string;
  filePath: string;
  definition: AgentDefinition;
  declaresSandbox: boolean;
}

const FIELDS = new Set(["name", "description", "developer_instructions", "model", "model_reasoning_effort", "sandbox_mode"]);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function parseProfile(content: string, filePath: string, policy: SandboxPolicy): Profile {
  let raw: ReturnType<typeof parse>;
  try {
    raw = parse(content, { integersAsBigInt: false });
  } catch {
    // Parser errors can quote source text, including credentials; do not relay them to the UI.
    throw new Error(`Invalid TOML: ${JSON.stringify(filePath)}`);
  }
  const unsupported = Object.keys(raw).filter((key) => !FIELDS.has(key));
  if (unsupported.length) throw new Error(`Unsupported Codex fields: ${unsupported.join(", ")}`);
  const { name, description, developer_instructions: prompt, model, model_reasoning_effort: effort, sandbox_mode: sandbox } = raw;
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,121}$/.test(name)) throw new Error("Invalid Codex agent name.");
  if (typeof description !== "string" || !description.trim()) throw new Error("Missing agent description.");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("Missing developer_instructions.");
  if (model !== undefined && (typeof model !== "string" || !model.trim())) throw new Error("Invalid model selector.");
  if (effort !== undefined && (typeof effort !== "string" || !EFFORTS.has(effort))) throw new Error("Unsupported model_reasoning_effort.");
  if (sandbox !== undefined && sandbox !== "read-only" && sandbox !== "workspace-write") throw new Error("Unsupported sandbox_mode.");
  if (sandbox !== undefined && policy !== "tool-policy") throw new Error("sandbox_mode requires piSubagentsImport.sandboxPolicy: 'tool-policy'; Pi tool policy is not an OS sandbox.");
  const definition: AgentDefinition = {
    description: description.trim(),
    systemPrompt: prompt.trim(),
    systemPromptMode: "append",
    inheritProjectContext: true,
    inheritGlobalContext: false,
    inheritSkills: true,
  };
  if (typeof model === "string") definition.model = model.trim();
  if (typeof effort === "string") definition.thinking = effort === "none" ? "off" : effort;
  if (sandbox === "read-only") {
    definition.tools = ["read", "grep", "find", "ls"];
    definition.extensions = [];
    definition.subagentOnlyExtensions = [];
    definition.allowNestedSubagents = false;
  }
  return { name: `codex.${name}`, filePath, definition, declaresSandbox: sandbox !== undefined };
}
