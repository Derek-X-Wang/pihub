import { Schema } from "effect";
import { Lockfile } from "./lockfile.js";
import { RegistryEntry } from "./registry.js";

/**
 * Per-agent describe payload — what `pihub describe <agent> --json` emits.
 * Combines the registry entry with the lockfile's install-time fields so
 * orchestrators see a single self-contained snapshot.
 */
export const AgentDescription = Schema.Struct({
  ...RegistryEntry.fields,
  installedAt: Schema.String,
  depsLockSha: Schema.String,
});
export type AgentDescription = typeof AgentDescription.Type;

export const buildAgentDescription = (entry: RegistryEntry, lock: Lockfile): AgentDescription => ({
  ...entry,
  installedAt: lock.installedAt,
  depsLockSha: lock.depsLockSha,
});
