import { Schema } from "effect";

/**
 * The seven `error.code` values surfaced by `pihub invoke --envelope`.
 * Mapped from pi `--mode json` stopReason + spawn-time conditions per
 * CONTEXT.md "Error code mapping".
 */
export const ErrorCode = Schema.Literal(
  "timeout",
  "llm_error",
  "tool_error",
  "abort",
  "auth_error",
  "runtime_error",
  "invalid_input",
);
export type ErrorCode = typeof ErrorCode.Type;

export const Usage = Schema.Struct({
  input: Schema.optional(Schema.Number),
  output: Schema.optional(Schema.Number),
  cost: Schema.optional(Schema.Number),
});
export type Usage = typeof Usage.Type;

export const ToolCallSummary = Schema.Struct({
  name: Schema.String,
  ok: Schema.Boolean,
});
export type ToolCallSummary = typeof ToolCallSummary.Type;

export const SuccessEnvelope = Schema.Struct({
  ok: Schema.Literal(true),
  agent: Schema.String,
  version: Schema.String,
  invocationId: Schema.String,
  output: Schema.String,
  usage: Usage,
  durationMs: Schema.Number,
  sessionId: Schema.optional(Schema.String),
  toolCalls: Schema.Array(ToolCallSummary),
});
export type SuccessEnvelope = typeof SuccessEnvelope.Type;

export const PartialState = Schema.Struct({
  lastAssistantMessage: Schema.optional(Schema.String),
  lastToolCall: Schema.optional(Schema.Unknown),
});
export type PartialState = typeof PartialState.Type;

export const InvocationError = Schema.Struct({
  code: ErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
});
export type InvocationError = typeof InvocationError.Type;

export const FailureEnvelope = Schema.Struct({
  ok: Schema.Literal(false),
  agent: Schema.String,
  version: Schema.String,
  invocationId: Schema.String,
  error: InvocationError,
  partial: Schema.optional(PartialState),
  durationMs: Schema.Number,
});
export type FailureEnvelope = typeof FailureEnvelope.Type;

export const InvocationEnvelope = Schema.Union(SuccessEnvelope, FailureEnvelope);
export type InvocationEnvelope = typeof InvocationEnvelope.Type;
