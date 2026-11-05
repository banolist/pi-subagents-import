# @banolist/pi-subagents-import

Use team-maintained `.codex/agents/*.toml` roles in Pi without generating copies
or modifying pi-subagents. This independent extension uses the public
`pi-subagents:runtime-agent-register:v1` event, not internal imports or another
agent runner. `smol-toml` belongs to this package only.

## Install

Requires Pi 1.2.0+, Node 22.19+ and a pi-subagents release exposing runtime event
registration (tested with stock pi-subagents 0.84.0). Install pi-subagents first.
The package is not published to npm; use a local checkout:

```sh
cd /path/to/pi-subagents-import
npm ci --ignore-scripts
pi install /path/to/pi-subagents-import
```

Run `/reload` in existing Pi sessions. Do not run both the old Codex-import fork
and this package if you want to avoid two sets of role names. This package does
not uninstall that fork or change your settings automatically.

## Names and source

`reviewer.toml` declaring `name = "reviewer"` registers as **`codex.reviewer`**.
The name inside TOML is authoritative, not the filename. No unprefixed aliases
are registered. Reserve the `codex.*` namespace for this package.

Ask Pi to use `codex.reviewer`, or inspect runtime agents with pi-subagents' list
action. They remain normal Pi children. The TOML files stay unchanged.

The nearest Git repository/worktree root is the project boundary, including
repositories without Codex profiles. In non-Git directories, discovery uses
the nearest ancestor `.codex` directory. It never treats the home directory's
personal `~/.codex` as a project. Subdirectories under `.codex/agents` are scanned
recursively. Symlinks inside the agent tree or at `.codex`/`agents` are refused.
Limits: 200 profiles, 1 MiB per profile, 2000 inspected directory entries.

## Sandbox policy

By default, profiles declaring `sandbox_mode` are rejected: a tool allowlist is
not Codex's OS sandbox. To explicitly accept that difference, add this to Pi
user settings or the project's `.pi/settings.json`:

```json
{
  "piSubagentsImport": {
    "sandboxPolicy": "tool-policy"
  }
}
```

| Codex | Runtime Pi definition |
| --- | --- |
| `name`, `description` | `codex.<name>` and description |
| `developer_instructions` | Role prompt, appended to Pi's base prompt |
| `model` | Model selector; no automatic provider conversion |
| `model_reasoning_effort` | Thinking; `none` maps to `off` |
| `sandbox_mode = "read-only"` | Only read/grep/find/ls; no shell, extensions, MCP or nested delegation |
| `sandbox_mode = "workspace-write"` | Ordinary Pi tools, **no workspace filesystem isolation** |

Required fields: name, description, developer_instructions. Missing model and
thinking inherit operator settings. Missing sandbox does not restrict tools.
Unknown fields, including MCP/provider/approval settings, and unsupported
sandbox modes are errors. Outer whitespace in prompts/descriptions is trimmed
to meet the runtime API's string contract. Project AGENTS.md and skills are
inherited; user-global AGENTS.md is not.

Operator `subagents.agentOverrides["codex.reviewer"]` model and thinking settings
still apply. Other fields of runtime definitions are extension-owned, as specified
by pi-subagents. Custom providers needed by read-only roles must be tested
separately because these roles do not load ambient extensions.

## Trust, exclusions and lifecycle

- Nothing is read or registered when `ctx.isProjectTrusted()` is false.
- The package honors `subagents.agentExcludeDirs` from both user settings and
  the selected project's `.pi/settings.json`. Paths are literal, not globs,
  relative to the settings file directory; `~/` expands to the home directory.
  Both lexical and canonical containment are checked before profile reads.
- Runtime names avoid builtin collisions. The owner refuses collisions with
  other runtime agents; conflicting configured names can also fail when the owner
  merges discovery. Do not create `.pi` profiles or aliases named `codex.*`.
- Parse/validation failures prevent the whole batch from registering. If a
  registration fails, already-registered roles from this batch are disposed.
  No compatible owner means a visible extension error, not a fallback runner.
- Registrations are disposed at session shutdown/reload/replacement. `/reload`
  rereads source files and removes deleted roles. There is no watcher and edits
  do not affect already-launched children.
- This is process-local: registrations do not automatically appear in other Pi
  processes. The package stays inert in native children marked
  `PI_SUBAGENT_CHILD=1`, where pi-subagents intentionally omits the parent owner.
  Nested delegation is not provisioned by this package.

Project trust and loaded extensions are operator decisions, not OS isolation.
The filesystem checks are discovery safeguards, not protection from a malicious
process racing file changes or from a malicious loaded extension.

## Development

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
PI_SUBAGENTS_ROOT=/path/to/installed/pi-subagents npm run test:integration
npm pack --dry-run
```

The integration test uses a real installed owner's registration listener and
runtime registry in a temporary project, without starting an LLM or child process.
It skips unless `PI_SUBAGENTS_ROOT` points to a package containing compiled
`src/agents/runtime-agent-events.js` and `runtime-agent-registry.js`.
