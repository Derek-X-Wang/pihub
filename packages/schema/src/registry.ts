import { Schema } from "effect";

/**
 * Shape α (Pi package — package.json `pi` field) or β (markdown agents).
 */
export const Shape = Schema.Literal("alpha", "beta");
export type Shape = typeof Shape.Type;

/**
 * One installed agent entry in the registry. For shape β with multiple
 * `agents/*.md`, each markdown agent gets its own entry; the canonical name
 * is `<dir>:<sub>`.
 *
 * `linked === true` means the agent's repo dir is a symlink (slice #6
 * `--link` mode); the registry/list surface marks linked agents distinctly.
 *
 * `permissions` is the manifest's advisory permission list — recorded only
 * in v1 (not enforced) per CONTEXT.md.
 */
export const RegistryEntry = Schema.Struct({
  name: Schema.String,
  shape: Shape,
  piSlot: Schema.String,
  source: Schema.String,
  ref: Schema.String,
  commitSha: Schema.String,
  description: Schema.String,
  invoke: Schema.String,
  envDeclared: Schema.Array(Schema.String),
  linked: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  permissions: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] }),
  /** Manifest's `timeoutSeconds` if set; falls back to the global default at invoke time. */
  timeoutSeconds: Schema.optional(Schema.Number),
});
export type RegistryEntry = typeof RegistryEntry.Type;

/**
 * Cached agent list at `~/.pihub/registry.json`. `version` is bumped on
 * breaking schema changes so old files can be migrated or rejected.
 */
export const Registry = Schema.Struct({
  version: Schema.Number,
  agents: Schema.Array(RegistryEntry),
});
export type Registry = typeof Registry.Type;

export const REGISTRY_VERSION = 1;
export const emptyRegistry: Registry = { version: REGISTRY_VERSION, agents: [] };
