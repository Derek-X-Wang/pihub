import { Schema } from "effect";

/**
 * `~/.pihub/aliases.json` — short → canonical-name mapping consulted by
 * `pihub invoke` before falling back to a registry lookup.
 */
export const Aliases = Schema.Struct({
  version: Schema.Number,
  map: Schema.Record({ key: Schema.String, value: Schema.String }),
});
export type Aliases = typeof Aliases.Type;

export const ALIASES_VERSION = 1;
export const emptyAliases: Aliases = { version: ALIASES_VERSION, map: {} };
