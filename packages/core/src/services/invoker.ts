import { ToolCallSummary, Usage } from "@pihub/schema";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
  AgentNotFoundError,
  InvokeOutputError,
  InvokeSpawnError,
  RegistryError,
  RuntimeSlotError,
} from "../errors.js";
import { Paths } from "../paths.js";
import { RegistryStore } from "./registry-store.js";
import { RuntimeSlotManager } from "./runtime-slot.js";

/**
 * Aggregated outcome of a single Pi invocation. Carries both the default-text
 * projection and the raw JSONL stream, plus the rich envelope-shaped fields
 * (invocationId, durationMs, sessionId, usage, toolCalls, stopReason,
 * errorMessage) so the CLI can render the slice-#11 envelope without a second
 * pass over the stream.
 */
export interface InvokeResult {
  readonly text: string;
  readonly raw: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly invocationId: string;
  readonly agent: string;
  readonly version: string;
  readonly durationMs: number;
  readonly sessionId: string | undefined;
  readonly usage: Usage;
  readonly toolCalls: ReadonlyArray<ToolCallSummary>;
  readonly stopReason: string | undefined;
  readonly errorMessage: string;
  readonly lastAssistantMessage: string;
  readonly lastToolCall: unknown;
}

export type InvokerError =
  | AgentNotFoundError
  | RegistryError
  | RuntimeSlotError
  | InvokeSpawnError
  | InvokeOutputError;

export interface InvokerShape {
  readonly invoke: (agentName: string, task: string) => Effect.Effect<InvokeResult, InvokerError>;
}

/** Minimal slice of pi's TextContent block. */
const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const decodeTextContent = Schema.decodeUnknown(TextContent);

const extractText = (content: ReadonlyArray<unknown>): string => {
  const parts: string[] = [];
  for (const block of content) {
    const decoded = Effect.runSyncExit(decodeTextContent(block));
    if (decoded._tag === "Success") parts.push(decoded.value.text);
  }
  return parts.join("");
};

const tryParseJson = (line: string): unknown | null => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
};

const numberOr = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

const stringOr = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

interface AggregatedEvents {
  readonly text: string;
  readonly sessionId: string | undefined;
  readonly usage: Usage;
  readonly toolCalls: ReadonlyArray<ToolCallSummary>;
  readonly stopReason: string | undefined;
  readonly errorMessage: string;
  readonly lastAssistantMessage: string;
  readonly lastToolCall: unknown;
}

/**
 * Single-pass aggregator over a `pi --mode json` JSONL buffer. We only ever
 * read what the envelope actually needs — unknown event types pass through.
 * Trade-off: aggregation is O(n) but happens after the spawn returns;
 * real-time streaming sits in slice #16's log capture.
 */
const aggregate = (stdout: string): AggregatedEvents => {
  let lastAssistantText = "";
  let lastAssistantMessage = "";
  let lastToolCall: unknown = undefined;
  let sessionId: string | undefined;
  let stopReason: string | undefined;
  let errorMessage = "";
  let usageInput: number | undefined;
  let usageOutput: number | undefined;
  let usageCost: number | undefined;
  const toolCalls: Array<ToolCallSummary> = [];

  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const raw = tryParseJson(line);
    if (typeof raw !== "object" || raw === null) continue;
    const evt = raw as Record<string, unknown>;
    const type = evt["type"];

    if (type === "session") {
      const id = stringOr(evt["id"]);
      if (id) sessionId = id;
    } else if (type === "message_end") {
      const msg = evt["message"];
      if (typeof msg !== "object" || msg === null) continue;
      const m = msg as Record<string, unknown>;
      if (m["role"] !== "assistant") continue;
      const content = Array.isArray(m["content"]) ? (m["content"] as ReadonlyArray<unknown>) : [];
      const text = extractText(content);
      lastAssistantText = text;
      lastAssistantMessage = text;
      const sr = stringOr(m["stopReason"]);
      if (sr) stopReason = sr;
      const em = stringOr(m["errorMessage"]);
      if (em) errorMessage = em;
      const u = m["usage"];
      if (typeof u === "object" && u !== null) {
        const ur = u as Record<string, unknown>;
        usageInput = numberOr(ur["input"]) ?? usageInput;
        usageOutput = numberOr(ur["output"]) ?? usageOutput;
        usageCost = numberOr(ur["cost"]) ?? usageCost;
      }
    } else if (type === "tool_execution_end") {
      const name = stringOr(evt["toolName"]) ?? "";
      const isError = evt["isError"] === true;
      toolCalls.push({ name, ok: !isError });
      lastToolCall = evt;
    }
  }

  const usage: Usage = {};
  if (usageInput !== undefined) (usage as { input: number }).input = usageInput;
  if (usageOutput !== undefined) (usage as { output: number }).output = usageOutput;
  if (usageCost !== undefined) (usage as { cost: number }).cost = usageCost;

  return {
    text: lastAssistantText,
    sessionId,
    usage,
    toolCalls,
    stopReason,
    errorMessage,
    lastAssistantMessage,
    lastToolCall,
  };
};

const lookupRegistry = (registry: typeof RegistryStore.Service, name: string) =>
  Effect.gen(function* () {
    const reg = yield* registry.read;
    const entry = reg.agents.find((a) => a.name === name);
    if (!entry) {
      return yield* Effect.fail(
        new AgentNotFoundError({
          name,
          message: `no agent named ${name} — run \`pihub list\``,
        }),
      );
    }
    return entry;
  });

const agentRootOf = (canonical: string): string => {
  const colon = canonical.indexOf(":");
  return colon === -1 ? canonical : canonical.slice(0, colon);
};

export class Invoker extends Context.Tag("Invoker")<Invoker, InvokerShape>() {
  static readonly Live = Layer.effect(
    Invoker,
    Effect.gen(function* () {
      const registry = yield* RegistryStore;
      const runtime = yield* RuntimeSlotManager;
      const paths = yield* Paths;
      return {
        invoke: (name, task) =>
          Effect.gen(function* () {
            const invocationId = randomUUID();
            const startedAt = Date.now();
            const entry = yield* lookupRegistry(registry, name);
            const binary = yield* runtime.ensureSlot(entry.piSlot);
            const profile = paths.agentProfile(agentRootOf(name));
            const env: Record<string, string> = {
              ...process.env,
              PI_CODING_AGENT_DIR: profile,
              PI_PACKAGE_DIR: path.join(profile, "packages"),
            };
            const result = yield* Effect.tryPromise({
              try: () =>
                new Promise<{ stdout: string; stderr: string; exitCode: number }>(
                  (resolve, reject) => {
                    const child = spawn(binary, ["--mode", "json", "--no-session", "-p", task], {
                      env,
                      stdio: ["ignore", "pipe", "pipe"],
                    });
                    const stdoutChunks: Buffer[] = [];
                    const stderrChunks: Buffer[] = [];
                    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
                    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
                    child.on("error", reject);
                    child.on("close", (code) =>
                      resolve({
                        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                        stderr: Buffer.concat(stderrChunks).toString("utf8"),
                        exitCode: code ?? 1,
                      }),
                    );
                  },
                ),
              catch: (e) => new InvokeSpawnError({ binary, message: `spawn failed: ${String(e)}` }),
            });
            const agg = aggregate(result.stdout);
            const text = result.exitCode === 0 ? agg.text : "";
            const durationMs = Date.now() - startedAt;
            return {
              text,
              raw: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              invocationId,
              agent: entry.name,
              version: entry.commitSha,
              durationMs,
              sessionId: agg.sessionId,
              usage: agg.usage,
              toolCalls: agg.toolCalls,
              stopReason: agg.stopReason,
              errorMessage: agg.errorMessage,
              lastAssistantMessage: agg.lastAssistantMessage,
              lastToolCall: agg.lastToolCall,
            } satisfies InvokeResult;
          }),
      } satisfies InvokerShape;
    }),
  );
}
