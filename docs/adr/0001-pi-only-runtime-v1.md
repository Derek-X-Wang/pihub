# Pi-only runtime in v1, no runtime abstraction

PiHub v1 targets the Pi ecosystem (`badlogic/pi-mono`) as its only supported agent runtime. We deliberately skip the `runtime` adapter layer that would let PiHub host non-Pi agents (Claude Code, Codex, Python, etc.) until v3+. The bet: shipping a tight, end-to-end great experience for one runtime is more valuable right now than building a pluggable surface against a single concrete consumer.

## Considered Options

- **Multi-runtime from day 1** — define `Runtime` interface, ship Pi as the first implementation. Rejected: forces premature abstraction over a runtime story we don't fully understand yet.
- **Runtime-agnostic at the IO boundary** (just JSON stdin/stdout, any executable) — rejected by user: too generic to give "best experience" for Pi.
- **Pi-only, hard-coupled** (chosen) — manifest's `runtime` field accepts only `"pi"` v1; install/invoke/profile/log paths assume Pi semantics.

## Consequences

The install detection rules, the `pi --mode json --no-session` invocation strategy, the per-minor runtime slots, and the profile-isolation mechanism all hard-code Pi assumptions. Adding a second runtime later requires a real refactor — likely lifting these into a `Runtime` interface — not a drop-in adapter. We accept that cost in exchange for v1 velocity.
