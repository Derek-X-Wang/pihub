import { Schema } from "effect";

/**
 * Per-agent install lockfile at `~/.pihub/agents/<id>/install.lock.json`.
 * Records the exact source, ref, commit, runtime slot, and bun.lock hash so
 * that re-installs are reproducible until `pihub update` is invoked.
 */
export const Lockfile = Schema.Struct({
  source: Schema.String,
  ref: Schema.String,
  commitSha: Schema.String,
  piSlot: Schema.String,
  depsLockSha: Schema.String,
  installedAt: Schema.String,
});

export type Lockfile = typeof Lockfile.Type;
