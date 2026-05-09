# PiHub

Local-first operational runtime for executable AI sub-agents. Pi is the first supported runtime ecosystem.

> **Status:** v1 in active development. See the [PRD](https://github.com/Derek-X-Wang/pihub/issues/1) and [open issues](https://github.com/Derek-X-Wang/pihub/issues?q=is%3Aopen+label%3Aready-for-agent) for what's being built.

## What problem does this solve?

General-purpose AI orchestrators (Claude Code, Codex, custom agents) become operationally unreliable as the number of skills, prompts, and tools grows. Skills are probabilistic — the orchestrator decides if/when/how to use each one, and that nondeterminism compounds.

PiHub is a deterministic invocation boundary around specialized **Agents**. Each Agent is a git repository conforming to a small contract; PiHub installs Agents from GitHub, npm, or local paths; pins them in isolated per-Agent profiles; and runs them on demand as fresh subprocesses.

```
master orchestrator (Claude Code, etc.)
   ↓ pihub invoke aws-cost-agent "what's my Q3 spend"
   ↓ deterministic boundary
PiHub runtime
   ↓ spawns isolated Pi process
specialized agent (probabilistic LLM inside)
```

The model is **deterministic orchestration around probabilistic intelligence** — the LLM stays probabilistic; invocation, lifecycle, and execution boundaries are deterministic.

## Architecture at a glance

- **Bun monorepo**: `apps/cli` (`@pihub/cli`), `packages/core` (`@pihub/core`), `packages/schema` (`@pihub/schema`).
- **Effect v3** stack with `@effect/cli`, `@effect/platform-bun`, `Schema.TaggedError`.
- **Pi-only v1.** [`badlogic/pi-mono`](https://github.com/badlogic/pi-mono) is the supported Agent runtime. Multi-runtime is a v3+ concern (see [ADR-0001](docs/adr/0001-pi-only-runtime-v1.md)).

See [`CONTEXT.md`](CONTEXT.md) for the full domain glossary and locked design decisions, and [`docs/adr/`](docs/adr/) for ADRs.

## Development

Requires [Bun](https://bun.sh) ≥ 1.x.

```bash
git clone https://github.com/Derek-X-Wang/pihub
cd pihub
bun install
bun run test       # vitest
bun run lint       # oxlint
bun run typecheck  # tsc --noEmit
bun run build      # compile single binary to dist/pihub
```

## License

MIT — see [LICENSE](LICENSE).
