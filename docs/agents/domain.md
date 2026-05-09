# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The producer skill (`/grill-with-docs`) creates them lazily when terms or decisions actually get resolved.

## File structure

This repo is **single-context**:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-pi-only-runtime-v1.md
│   ├── 0002-optional-manifest-shape-detection.md
│   ├── 0003-per-minor-pi-runtime-slots.md
│   └── 0004-pi-mode-json-no-session-always.md
└── (apps/, packages/, etc.)
```

For reference, multi-context repos use `CONTEXT-MAP.md` at the root pointing to per-context `CONTEXT.md` files (typically a monorepo with strong context boundaries — e.g. `src/ordering/CONTEXT.md`, `src/billing/CONTEXT.md`). Switch to that layout when this repo grows enough to warrant it.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/grill-with-docs`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001 (Pi-only runtime in v1) — but worth reopening because…_
