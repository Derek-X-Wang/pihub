import { Schema } from "effect";

/**
 * `tools` in pi-style markdown agents accepts either a comma-separated string
 * (`tools: read, grep, find`) or a YAML array (`tools: [read, grep]`). Both
 * forms appear in the wild — see `pi-mono/packages/coding-agent/examples`.
 */
const ToolsField = Schema.Union(Schema.String, Schema.Array(Schema.String));

/**
 * YAML frontmatter on a shape-β agent markdown file (`agents/<sub>.md`). Only
 * `name` is required — that becomes the `<sub>` in the canonical id.
 */
export const BetaAgentFrontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  description: Schema.optional(Schema.String),
  tools: Schema.optional(ToolsField),
  model: Schema.optional(Schema.String),
});
export type BetaAgentFrontmatter = typeof BetaAgentFrontmatter.Type;
