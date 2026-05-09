import { Schema } from "effect";

/**
 * `~/.pihub/config.json` — small flat key/value store for PiHub-global
 * settings. Per-agent config lives in each agent's `pihub.json` manifest.
 *
 * Every field is optional; consumers read defaults from `ConfigDefaults`
 * when a key is missing.
 */
export const PihubConfig = Schema.Struct({
  "timeout.default": Schema.optional(Schema.Number),
  "logs.retention": Schema.optional(Schema.Number),
  "runtime.defaultMinor": Schema.optional(Schema.String),
  "install.parallel": Schema.optional(Schema.Number),
  "network.githubToken": Schema.optional(Schema.String),
});
export type PihubConfig = typeof PihubConfig.Type;

export const emptyPihubConfig: PihubConfig = {};

/**
 * Defaults — when a key is unset, the consumer reads from here. Keep these in
 * sync with the literals scattered through the codebase (DEFAULT_INVOKE_TIMEOUT_S,
 * DEFAULT_LOG_RETENTION, DEFAULT_PI_SLOT).
 */
export const ConfigDefaults = {
  "timeout.default": 600,
  "logs.retention": 50,
  "runtime.defaultMinor": "0.74",
  "install.parallel": 4,
} as const;

/** All valid keys. `pihub config set` rejects anything not in this set. */
export const CONFIG_KEYS: ReadonlyArray<keyof PihubConfig> = [
  "timeout.default",
  "logs.retention",
  "runtime.defaultMinor",
  "install.parallel",
  "network.githubToken",
];

export const isConfigKey = (key: string): key is keyof PihubConfig =>
  (CONFIG_KEYS as ReadonlyArray<string>).includes(key);
