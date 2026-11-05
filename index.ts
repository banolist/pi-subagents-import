import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collectProfiles, findProjectRoot } from "./src/discovery.ts";
import type { AgentDefinition, SandboxPolicy } from "./src/profiles.ts";

export const REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";

interface Registration { dispose(): void }
interface Request {
  version: 1;
  name: string;
  definition: AgentDefinition;
  result?: { ok: true; registration: Registration } | { ok: false; error: Error };
}

function sandboxPolicy(settings: unknown): SandboxPolicy {
  if (!settings || typeof settings !== "object" || !("piSubagentsImport" in settings)) return "reject";
  const config = settings.piSubagentsImport;
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("piSubagentsImport must be an object.");
  if (Object.keys(config).some((key) => key !== "sandboxPolicy")) throw new Error("Unknown piSubagentsImport setting; only sandboxPolicy is supported.");
  if (!("sandboxPolicy" in config)) return "reject";
  if (config.sandboxPolicy !== "reject" && config.sandboxPolicy !== "tool-policy") throw new Error("piSubagentsImport.sandboxPolicy must be 'reject' or 'tool-policy'.");
  return config.sandboxPolicy;
}

export default function (pi: ExtensionAPI) {
  let registrations: Registration[] = [];
  const dispose = (): void => {
    for (const registration of registrations) registration.dispose();
    registrations = [];
  };

  pi.on("session_start", (_event, ctx) => {
    dispose();
    // The parent pi-subagents owner is intentionally absent in native child processes.
    if (process.env.PI_SUBAGENT_CHILD === "1") return;
    // Runtime registration does not inherit discovery trust checks from pi-subagents.
    if (!ctx.isProjectTrusted()) return;
    const root = findProjectRoot(ctx.cwd);
    if (!root) return;
    const policy = sandboxPolicy(pi.getSettings());
    const agentDir = path.resolve(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi/agent"));
    const profiles = collectProfiles(root, agentDir, policy);
    try {
      for (const profile of profiles) {
        const request: Request = { version: 1, name: profile.name, definition: profile.definition };
        pi.events.emit(REGISTER_EVENT, request);
        if (!request.result) throw new Error("pi-subagents is not ready or does not support runtime registration. Install a compatible pi-subagents package before pi-subagents-import.");
        if (request.result.ok === false) throw request.result.error;
        if (request.result.ok !== true || typeof request.result.registration?.dispose !== "function") throw new Error("Malformed pi-subagents runtime registration result.");
        registrations.push(request.result.registration);
      }
    } catch (error) {
      dispose();
      throw error;
    }
    if (profiles.some((profile) => profile.declaresSandbox)) {
      ctx.ui.notify("Codex agents use Pi tool policy, NOT an OS sandbox. Read-only has no shell/MCP; workspace-write is not filesystem-isolated.", "warning");
    }
    if (profiles.length) ctx.ui.notify(`Registered ${profiles.length} Codex agents (codex.*).`, "info");
  });
  pi.on("session_shutdown", dispose);
}
