# Always spawn `pi --mode json --no-session`

PiHub always spawns the underlying pi process with `--mode json --no-session`, regardless of which output mode the caller asked for. The default text output, the `--stream` JSONL pass-through, and the `--envelope` aggregated form are all _projections_ over the same captured event stream. PiHub itself owns log capture, output projection, and timeout/abort wiring.

## Considered Options

- **`pi -p` for default, `pi --mode json` for `--stream`** — rejected: two code paths inside the invoker, and we can't capture a structured transcript when running in `-p` mode.
- **`pi --session <uuid>` so pi writes its own JSONL to disk** — rejected: violates spec's "no persistent sessions" stance and bloats per-agent profile.
- **`pi --mode json --no-session` always, project at PiHub layer** (chosen) — single internal code path, stateless from pi's view, full observability captured by PiHub into its own ring-buffered logs.

## Consequences

The output projection logic is non-trivial and lives entirely in `services/invoker.ts`. Future pi event types (added by upstream) may require updates here; PiHub keeps a permissive parser (unknown event types pass through verbatim in `--stream` mode, are ignored in default text mode). The trade is: the invoker is busier, but the rest of PiHub gets a clean unified contract — every invocation produces an event log on disk, regardless of how the caller asked to read the output.
