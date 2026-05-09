import { Schema } from "effect";
import { Runtime } from "./runtime.js";

/**
 * Optional `pihub.json` manifest. Every field is optional; an empty manifest is
 * valid and produces an all-defaults install. Lives at the agent repo root.
 */
export const Manifest = Schema.Struct({
  $schema: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  runtime: Schema.optional(Runtime),
  tags: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Array(Schema.String)),
  permissions: Schema.optional(Schema.Array(Schema.String)),
  timeoutSeconds: Schema.optional(Schema.Number),
});

export type Manifest = typeof Manifest.Type;

/** All-defaults manifest used when `pihub.json` is absent. */
export const emptyManifest: Manifest = {};
