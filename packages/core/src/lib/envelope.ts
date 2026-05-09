import { ErrorCode, FailureEnvelope, InvocationEnvelope, SuccessEnvelope } from "@pihub/schema";
import type { InvokeResult } from "../services/invoker.js";

const AUTH_RE = /\bauth\b|401|403|unauthor|api[ _-]?key|forbidden/i;
const TOOL_RE = /\btool\b|tool[_ ]execution|tool[_ ]call/i;

/**
 * Map pi `stopReason` + a free-form errorMessage to one of the seven envelope
 * `error.code` values. The heuristic is intentionally simple: substring match
 * on common keywords, with `llm_error` as the safe fallback for unrecognised
 * pi `stopReason: "error"` cases.
 */
export const mapStopReasonToCode = (
  stopReason: string | undefined,
  errorMessage: string,
): ErrorCode => {
  if (stopReason === "aborted") return "abort";
  if (stopReason === "error") {
    if (AUTH_RE.test(errorMessage)) return "auth_error";
    if (TOOL_RE.test(errorMessage)) return "tool_error";
    return "llm_error";
  }
  // No stopReason but non-zero exit → treat as llm_error (safe fallback).
  return "llm_error";
};

/**
 * Build a SuccessEnvelope from an InvokeResult. Caller decides when to use
 * this — typically when `exitCode === 0`.
 */
export const buildSuccessEnvelope = (result: InvokeResult): SuccessEnvelope => {
  const env: SuccessEnvelope = {
    ok: true,
    agent: result.agent,
    version: result.version,
    invocationId: result.invocationId,
    output: result.text,
    usage: result.usage,
    durationMs: result.durationMs,
    toolCalls: result.toolCalls,
  };
  if (result.sessionId !== undefined) {
    (env as { sessionId: string }).sessionId = result.sessionId;
  }
  return env;
};

/**
 * Build a FailureEnvelope from an InvokeResult and a known error code. The
 * caller picks the code (mapStopReasonToCode for pi exits, `runtime_error`
 * for spawn failures, etc.).
 */
export const buildFailureEnvelope = (
  result: InvokeResult,
  code: ErrorCode,
  overrideMessage?: string,
): FailureEnvelope => {
  const message =
    overrideMessage ??
    (result.errorMessage.length > 0
      ? result.errorMessage
      : result.stderr.trim() || `pi exited with code ${result.exitCode}`);
  const env: FailureEnvelope = {
    ok: false,
    agent: result.agent,
    version: result.version,
    invocationId: result.invocationId,
    error: { code, message },
    durationMs: result.durationMs,
  };
  if (result.lastAssistantMessage.length > 0 || result.lastToolCall !== undefined) {
    const partial: { lastAssistantMessage?: string; lastToolCall?: unknown } = {};
    if (result.lastAssistantMessage.length > 0) {
      partial.lastAssistantMessage = result.lastAssistantMessage;
    }
    if (result.lastToolCall !== undefined) partial.lastToolCall = result.lastToolCall;
    (env as { partial: typeof partial }).partial = partial;
  }
  return env;
};

export const isSuccess = (env: InvocationEnvelope): env is SuccessEnvelope => env.ok === true;
