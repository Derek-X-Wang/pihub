# Per-minor Pi runtime slots

PiHub installs and pins Pi runtime binaries in per-minor-version slots at `~/.pihub/runtime/pi/<minor>/`, not as a single global binary. An agent declaring `~0.73.0` lives in slot `0.73`; a different agent declaring `~0.74.0` lives in slot `0.74`; both coexist on disk.

The choice is driven by a non-obvious convention in pi-mono itself: pi-mono uses lockstep versioning across all packages, **never bumps major** (versions stay `0.x.y`), and treats `minor` (`0.x`) as the breaking-change boundary. Since the breaking boundary is per-minor, isolating per-minor is the smallest unit of reproducibility that actually buys us cross-version compatibility.

## Consequences

A new reader will look at the directory layout and wonder why we don't just install one global pi binary like every other package manager does. The answer is two layers up: it's not about avoiding global state for its own sake — it's about pi's specific versioning convention making "global single binary" a guaranteed reproducibility-breaker as soon as a second agent installs that needs a different minor. Garbage collection of unused slots is `pihub gc-runtime`; refcounts live in the registry.
