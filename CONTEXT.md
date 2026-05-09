# PiHub — Domain Context

Local-first operational runtime for executable AI sub-agents. CLI + library. Bun monorepo, Effect v3 + `@effect/cli` + `@effect/platform-bun`. Lint/format: oxlint + prettier. Test: vitest + `@effect/vitest`. Pi is the first supported agent runtime.

## Repo layout (Split B monorepo)
```
pihub/
├── apps/cli/              → @pihub/cli (the binary)
└── packages/
    ├── core/              → @pihub/core (services + errors + paths)
    └── schema/            → @pihub/schema (Effect Schemas; agent-author dep)
```

## Runtime layout (`~/.pihub/`)
```
~/.pihub/
├── env                    # global dotenv (mode 0600)
├── registry.json          # cached agent list
├── aliases.json           # alias map
├── config.json            # PiHub global config
├── runtime/pi/<minor>/    # per-minor pi slot (bun-installed)
├── agents/<name>/
│   ├── repo/              # cloned source
│   ├── profile/           # PI_CODING_AGENT_DIR target
│   ├── env                # per-agent dotenv (mode 0600)
│   └── install.lock.json
└── logs/<YYYY-MM-DD>/<invocation-id>.jsonl
```

## Glossary

### Pi
External existing project. Github: `badlogic/pi-mono`. Cloned locally at `/Users/derekxwang/Development/incubator/PiHub/pi-mono`. Provides:
- `@mariozechner/pi-ai` — multi-provider LLM API
- `@mariozechner/pi-agent-core` — `Agent` class, tool calling, event streaming, state management
- `@mariozechner/pi-coding-agent` — interactive coding agent CLI with extensions/skills/prompts/themes/packages, RPC mode, JSON mode, subagent extension
- `@mariozechner/pi-tui`, `@mariozechner/pi-web-ui`

PiHub's `runtime: "pi"` means an agent constructed against the Pi ecosystem. Concrete contract TBD (see open questions).

### Agent
A git repository conforming to the PiHub agent contract: contains a `pihub.json` manifest plus an executable entrypoint. Each agent is operationally bounded, invokable, versionable independently, and runs as a fresh subprocess per invocation (stateless v1).

### Sub-agent
Used interchangeably with **Agent** in this project. PiHub does not distinguish — every PiHub-managed unit is a sub-agent of some external orchestrator.

### Manifest
Optional `pihub.json` at agent repo root. Declares ops metadata (env, permissions, IO mode, display name) when defaults aren't sufficient. **Not required.** PiHub auto-detects Pi-shaped repos via package.json `pi` field, presence of `agents/*.md`, or pi-agent-core dependency. Goal: zero adoption friction — any existing Pi repo works.

### Runtime
v1 ships only `pi`. No runtime-agnostic abstraction yet. The `runtime: "pi"` is implicit unless overridden. Multi-runtime is a v3+ concern.

### Pi profile isolation
Each installed agent gets its own pi config dir at `~/.pihub/agents/<agent-id>/profile/`. Achieved by setting `PI_CODING_AGENT_DIR` and `PI_PACKAGE_DIR` env vars when spawning `pi`. Each agent has independent settings, auth, sessions, extensions — no cross-contamination.

### Pi runtime slots
PiHub pins multiple pi minor versions side-by-side in `~/.pihub/runtime/pi/<minor>/`. Reason: pi-mono uses lockstep versioning where **minor = breaking** (no major bumps). Per minor = per breaking boundary.

Resolution per agent:
- Shape α: read `package.json` deps for `@mariozechner/pi-coding-agent`, parse semver range, pick slot.
- Shape β / missing dep: PiHub default slot.
- New slot at install → `bun install @mariozechner/pi-coding-agent@~<minor>.0` into slot dir.
- No auto-upgrade across slots. Explicit `pihub upgrade-runtime`.
- Refcount in registry; `pihub gc-runtime` prunes unused slots later.

### Invocation
A single execution of an agent. Stateless. Fresh `pi` subprocess. Default behavior proxies `pi -p` — text task in, final assistant text out, exit code = pi exit code, stderr passthrough.

Flags:
- `--stream` → proxy `pi --mode json` instead, raw JSONL events to stdout
- `--envelope` → aggregate JSONL into `{ok, output, agent, version, usage, durationMs, sessionId, toolCalls}` final JSON
- `--input <file>` → structured input from JSON file instead of positional task

### Identifier scheme
Canonical name = `<owner>/<repo>` for single-agent installs, `<owner>/<repo>:<sub>` for sub-agents (β multi-md). Source-URL → name mapping:
- `github:foo/agents` / `https://github.com/foo/agents` / `git@github.com:foo/agents` → `foo/agents`
- `npm:@scope/pkg` → `@scope/pkg`
- Local path → manifest name or directory basename

`pihub alias <short>=<canonical>` opt-in shortcut. Aliases stored in registry. Collisions surface at alias-set time.

### Env / auth (v1: API keys only)
Layered resolution at invocation time (highest wins):
1. Caller shell `process.env`
2. Per-agent file `~/.pihub/agents/<id>/env` (dotenv, mode 0600)
3. Global file `~/.pihub/env` (dotenv, mode 0600)

Filtered against agent's declared `env: [...]` if manifest present. No declaration = all layers pass through. Pi resolves API keys env-first, so env injection is the deterministic auth path. OAuth (`/login`) deferred post-v1.

CLI:
- `pihub env set [--agent <id>] KEY=value`
- `pihub env list [--agent <id>]`
- `pihub env unset [--agent <id>] KEY`

### Working directory
Default `cwd` at invocation = caller's `process.cwd()`. Agent's pi process inherits the same cwd. Pi's read/write/bash tools then operate on caller's project. Matches shell-tool conventions and skill-replacement semantics.

Flags:
- `--cwd <path>` → override
- `--sandbox` → fresh `mktemp -d`, removed on exit
- agent's clone dir never used as cwd (source isolation)

FS isolation v1: none beyond OS perms + pi's tool allowlist. `permissions: [...]` recorded in manifest but not enforced. v2+ concern.

### Source pinning + lockfile (L1)
Per agent at `~/.pihub/agents/<id>/install.lock.json`:
```json
{
  "source": "github:foo/bar",
  "ref": "v0.3.0",
  "commitSha": "abc...",
  "piSlot": "0.74",
  "depsLockSha": "<sha of bun.lock>",
  "installedAt": "..."
}
```
Resolution at install:
1. `<src>@<ref>` → use ref literal (tag/branch/sha)
2. `<src>` → highest semver tag matching `vX.Y.Z`, fallback default branch HEAD
3. Record commit SHA always

Update only via `pihub update [<agent>]` (re-resolves rule 2 or supplied ref). `--dry-run` previews. `--frozen` fails on drift (CI use).

Agent's `bun.lock` (or `package-lock.json`) preserved verbatim. If absent, PiHub generates one at install via `bun install --save-text-lockfile` and freezes.

### Discovery
Two surfaces v1:
1. `pihub list [--json]` — live query; spawns nothing else
2. `~/.pihub/registry.json` — cached file maintained on every install/update/remove; same shape as `--json` output; cheap to read

Description sourcing precedence:
1. `pihub.json.description` if manifest present
2. Shape α: package.json `description` + extension command descriptions
3. Shape β: markdown frontmatter `description:`
4. Fallback: README first paragraph

Schema of registry entry:
```json
{
  "name": "foo/agents:scout",
  "shape": "beta",
  "piSlot": "0.74",
  "source": "github:foo/agents",
  "ref": "v0.3.0",
  "commitSha": "abc...",
  "description": "Fast codebase recon, returns compressed context",
  "invoke": "pihub invoke foo/agents:scout \"<task>\"",
  "envDeclared": ["ANTHROPIC_API_KEY"]
}
```

`pihub describe <name> [--json]` returns full per-agent detail. Orchestrator integration (CLAUDE.md fragment, MCP server, etc.) deferred post-v1.

### Concurrency / sessions / transcripts (C3)
PiHub always spawns `pi --mode json --no-session` under the hood. Pi profile sees no session writes (stateless per spec). PiHub captures the JSONL event stream into its own ring-buffer log:

- Path: `~/.pihub/logs/<YYYY-MM-DD>/<invocation-id>.jsonl`
- Default retention: last 50 invocations per agent (configurable)
- `pihub logs <agent> [--limit N] [--since <time>]` to view
- `pihub gc-logs` manual prune

Output filter is a projection over the captured stream:
- default → extract final assistant text
- `--stream` → passthrough raw JSONL
- `--envelope` → aggregate to `{ok, output, agent, version, usage, durationMs, sessionId, toolCalls}`

Concurrency:
- Each invocation gets unique `invocation-id` (uuid). Own log file. No contention.
- Profile dir read-only during invocation; PiHub takes shared lock on `<profile>/.pihub.lock`.
- `pihub install/update/remove` takes exclusive lock on the same path.
- Pi runtime slot dir never mutated at invoke time.

### Timeout / abort / errors
Default timeout 600s. Override precedence: `--timeout <s>` > `pihub.json.timeoutSeconds` > `pihub config get timeout.default` > 600.

Abort: PiHub receives SIGINT → forwards to pi subprocess → 5s grace → SIGKILL if still alive → exit 130 to caller.

Exit codes:
- `0` success
- `1` agent failure (pi non-zero stop reason)
- `2` invalid input (unknown agent, bad args, manifest validation)
- `124` timeout
- `125` pihub runtime missing / corrupt
- `130` aborted by signal

Error envelope (when `--envelope` set):
```json
{
  "ok": false,
  "agent": "foo/bar",
  "version": "0.3.0",
  "invocationId": "uuid",
  "error": {"code": "timeout|llm_error|tool_error|abort|auth_error|runtime_error|invalid_input", "message": "...", "details": {}},
  "partial": {"lastAssistantMessage": "...", "lastToolCall": {}},
  "durationMs": 12345
}
```

Error code mapping from pi stop reasons:
- pi `aborted` → `abort`
- pi `error` + auth-related → `auth_error`
- pi `error` + tool-related → `tool_error`
- pi `error` other → `llm_error`
- timeout fired → `timeout`
- pi spawn failure → `runtime_error`
- pre-spawn validation failure → `invalid_input`

No retry v1. Caller retries explicitly if needed.

### CLI surface (v1)
```
install <source>[@<ref>] [--frozen]
update [<agent>] [--dry-run] [--frozen]
remove <agent>
list [--json]
describe <agent> [--json]
invoke <agent> [task] [--input <file>] [--stream] [--envelope]
               [--timeout <s>] [--cwd <path>] [--sandbox] [--log]
run <source>[@<ref>] [task] [...]              ← ephemeral install+invoke, no registry persist
env set|list|unset [--agent <id>] [KEY[=value]]
alias <short>=<canonical> | alias list | alias remove <short>
logs <agent> [--limit N] [--since <t>]
gc-logs
runtime list | runtime install <minor> | runtime remove <minor>
config get|set|list <key> [<value>]
doctor
--version | --help
```

Deferred post-v1: `login` (OAuth), `serve` (MCP/HTTP adapter), `init` (scaffolder), `eval` (test harness).

### `pihub.json` (optional, all fields optional)
```json
{
  "$schema": "https://pihub.dev/schema/v1.json",
  "name": "string",
  "description": "string",
  "version": "string",
  "runtime": "pi",
  "tags": ["string"],
  "env": ["KEY"],
  "permissions": ["string"],
  "timeoutSeconds": 600
}
```

| Field | Default | Notes |
|-------|---------|-------|
| `name` | derived from source URL | override canonical id |
| `description` | extracted per Q10 rules | ≤ 280 chars |
| `version` | empty | informational only |
| `runtime` | `"pi"` | only `"pi"` v1; unknown → `invalid_input` |
| `tags` | `[]` | search/filter |
| `env` | undefined → all layers pass through | string[] allowlist filter |
| `permissions` | `[]` | **recorded only v1**; enforcement v2+ |
| `timeoutSeconds` | 600 | per-agent default; flag overrides |

Validation via Effect `Schema` at install time. Invalid → exit `2`. Missing file → all defaults. Unknown fields ignored unless `--strict-manifest`.

### Source URL kinds (v1)
```
github:owner/repo[@ref]                  → https://github.com/owner/repo, ref optional
https://github.com/owner/repo[@ref]      → same
npm:pkg[@version], npm:@scope/pkg[@ver]  → npm registry
./relative or /absolute path             → local clone
```

`<ref>` accepts tag, branch, or commit SHA. Local path default = `cp -r` into `~/.pihub/agents/<name>/repo/` (immutable, lockfile-frozen). `--link` flag = symlink for live-dev (skips lockfile freeze).

Deferred v2: `ssh://`, `git@`, `git+https://`, gitlab/bitbucket hosts.

### Distribution (v1)
Two pipelines from day one, both fed by the same GitHub Actions release on tag `v*`:

**Binary via `install.sh`:**
- Matrix build: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`
- `bun build apps/cli/src/cli.ts --compile --target=bun-<platform>-<arch>`
- Tar + checksum, upload to GitHub Release
- `install.sh` detects platform, fetches tarball, installs to `~/.local/bin/pihub`
- User: `curl -fsSL <repo-raw>/install.sh | bash` (cname to `pihub.sh` post-domain-acquisition)

**npm publish:**
- `@pihub/schema` — pure Effect Schema, Node 20+ compatible (no Bun dep)
- `@pihub/core` — engine, requires Bun (uses `@effect/platform-bun`)
- `@pihub/cli` — entrypoint, requires Bun, `bin: "./src/cli.ts"` with `#!/usr/bin/env bun` shebang
- README documents Bun requirement for cli/core; agent authors only need `@pihub/schema` for typed manifest validation

**Skip v1:**
- Windows (bun --compile supports but child_process semantics differ; defer)
- Homebrew tap, apt/yum
- Tsc compile of cli/core for Node-only npm consumers (publish source-only, require Bun)

### Skill-replacement model
Mental model from user: PiHub agents replace what Claude Code "skills" do today, but deterministically. Master orchestrator (Claude Code, etc.) currently loads skills probabilistically — context pollution, nondeterministic selection. PiHub agent invocation is explicit (`pihub invoke X`), bounded (subprocess), and isolated (no skill leakage into master context). Each agent should feel **skill-sized** — one focused capability, not a framework.

### Detection rules (v1, Pi-only)
On `pihub install <url>`:
1. `package.json` has `pi` field → **shape α** (Pi package). Install via `pi install` into isolated profile.
2. `agents/*.md` files present → **shape β** (markdown agents). Symlink/copy into profile's `agents/`.
3. Both → α dominant, β agents registered alongside.
4. Neither → reject with error.

Shape γ (raw pi-agent-core bin script) deferred to post-v1.
