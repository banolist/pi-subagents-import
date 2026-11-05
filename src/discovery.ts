import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseProfile, type Profile, type SandboxPolicy } from "./profiles.ts";

function absent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function exists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}

/** Git worktrees are boundaries, including those without any Codex configuration. */
export function findProjectRoot(cwd: string): string | undefined {
  const home = fs.realpathSync(os.homedir());
  let current = fs.realpathSync(cwd);
  let nearestCodex: string | undefined;
  while (current !== home) {
    if (exists(path.join(current, ".git"))) return current;
    if (!nearestCodex && exists(path.join(current, ".codex"))) nearestCodex = current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return nearestCodex;
}

function canonical(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    if (!absent(error)) throw error;
    const parent = path.dirname(filePath);
    return parent === filePath ? filePath : path.join(canonical(parent), path.basename(filePath));
  }
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function settingsExclusions(filePath: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (absent(error)) return [];
    throw new Error(`Cannot read settings: ${JSON.stringify(filePath)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Settings must be an object.");
  if (!("subagents" in raw)) return [];
  const section = raw.subagents;
  if (!section || typeof section !== "object" || Array.isArray(section)) throw new Error("subagents settings must be an object.");
  if (!("agentExcludeDirs" in section)) return [];
  const entries = section.agentExcludeDirs;
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string" || !entry.trim())) throw new Error("subagents.agentExcludeDirs must be an array of nonempty strings.");
  return entries.map((entry: string) => path.resolve(path.dirname(filePath), entry.startsWith("~/") ? path.join(os.homedir(), entry.slice(2)) : entry));
}

export function collectProfiles(projectRoot: string, agentDir: string, policy: SandboxPolicy): Profile[] {
  const exclusions = [path.join(agentDir, "settings.json"), path.join(projectRoot, ".pi/settings.json")]
    .flatMap(settingsExclusions).map((root) => ({ lexical: root, real: canonical(root) }));
  const excluded = (filePath: string): boolean => exclusions.some((root) => contains(root.lexical, filePath) || contains(root.real, canonical(filePath)));
  const codex = path.join(projectRoot, ".codex");
  const root = path.join(codex, "agents");
  if (excluded(root)) return [];
  for (const directory of [codex, root]) {
    if (!exists(directory)) return [];
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Expected a non-symlink directory: ${JSON.stringify(directory)}`);
  }
  const profiles: Profile[] = [];
  const names = new Set<string>();
  const pending = [root];
  let inspected = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (excluded(filePath)) continue;
      if (++inspected > 2000) throw new Error("Codex agent tree exceeds 2000 entries.");
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported in Codex agents: ${JSON.stringify(filePath)}`);
      if (entry.isDirectory()) {
        pending.push(filePath);
      } else if (entry.isFile() && entry.name.endsWith(".toml")) {
        if (profiles.length >= 200 || fs.statSync(filePath).size > 1024 * 1024) throw new Error("Codex profile limit exceeded (200 profiles, 1 MiB per file).");
        let profile: Profile;
        try {
          profile = parseProfile(fs.readFileSync(filePath, "utf8"), filePath, policy);
        } catch (error) {
          throw new Error(`${JSON.stringify(filePath)}: ${error instanceof Error ? error.message : "Invalid profile"}`);
        }
        if (names.has(profile.name)) throw new Error(`Duplicate Codex role: ${profile.name}`);
        names.add(profile.name);
        profiles.push(profile);
      }
    }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}
