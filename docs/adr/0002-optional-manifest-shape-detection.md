# Optional manifest, zero-config Pi-shape detection

PiHub does not require a `pihub.json` manifest in installed agent repos. Instead, `pihub install <url>` auto-detects shape α (Pi package — `pi` field in `package.json`) or shape β (markdown agents — `agents/*.md` with YAML frontmatter) and configures the install accordingly. Manifest is purely an *override* layer for cases where defaults aren't sufficient.

## Considered Options

- **Required manifest** (e.g., `pihub.json` mandatory) — rejected: forces every existing Pi repo to be modified before PiHub can install it. Adoption-blocking for a project just starting out.
- **Manifest-optional with detection** (chosen) — any existing Pi-shaped repo works on day one; authors only touch manifest when they want to override env declarations, name, timeout, etc.
- **Detection-only, no manifest at all** — rejected: legitimate use cases (env declarations, custom timeout, permission surfaces in v2+) need a place to live.

## Consequences

Detection rules become a public contract. Changing them later (e.g., recognizing a new third shape) is fine — additive — but tightening them (e.g., requiring a specific structure in shape β) breaks installs. The detector lives in `services/shape-detector.ts` and is the single source of truth for "what counts as a Pi-runnable repo."
