import { Schema } from "effect";

/**
 * Sidecar metadata written next to every invocation's `.jsonl` log so
 * `pihub logs <agent>` can attribute logs to agents and surface a useful
 * one-line summary without reading the full event stream.
 */
export const LogMeta = Schema.Struct({
  invocationId: Schema.String,
  agent: Schema.String,
  startedAt: Schema.String,
  durationMs: Schema.Number,
  exitCode: Schema.Number,
  firstPromptLine: Schema.String,
});
export type LogMeta = typeof LogMeta.Type;
