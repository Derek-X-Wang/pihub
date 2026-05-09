import { ToolCallSummary, Usage } from "@pihub/schema";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import {
  AgentNotFoundError,
  AliasStoreError,
  EnvFileError,
  InvokeCwdNotFoundError,
  InvokeInvalidArgsError,
  InvokeOutputError,
  InvokeSpawnError,
  LogStoreError,
  RegistryError,
  RuntimeSlotError,
} from "../errors.js";
import { Paths } from "../paths.js";
import { AliasStore } from "./alias-store.js";
import { EnvResolver } from "./env-resolver.js";
import { DEFAULT_LOG_RETENTION, LogStore } from "./log-store.js";
import { RegistryStore } from "./registry-store.js";
import { RuntimeSlotManager } from "./runtime-slot.js";

/**
 * Aggregated outcome of a single Pi invocation. Carries both the default-text
 * projection and the raw JSONL stream, plus the rich envelope-shaped fields
 * (invocationId, durationMs, sessionId, usage, toolCalls, stopReason,
 * errorMessage) so the CLI can render the slice-#11 envelope without a second
 * pass over the stream.
 */
export type TerminationReason = "timeout" | "abort" | null;

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
  /** Why pi was killed externally, if anything. `null` for natural exits. */
  readonly terminationReason: TerminationReason;
}

export type InvokerError =
  | AgentNotFoundError
  | RegistryError
  | RuntimeSlotError
  | InvokeSpawnError
  | InvokeOutputError
  | InvokeCwdNotFoundError
  | InvokeInvalidArgsError
  | EnvFileError
  | AliasStoreError
  | LogStoreError;

export interface InvokeOptions {
  /** Override the cwd handed to pi. Mutually exclusive with `sandbox`. */
  readonly cwd?: string;
  /** Spawn pi in a fresh tempdir; remove it on exit. Mutually exclusive with `cwd`. */
  readonly sandbox?: boolean;
  /**
   * Hard timeout in seconds. Precedence: opts.timeoutSeconds > registry
   * entry's `timeoutSeconds` (from manifest) > 600s default.
   */
  readonly timeoutSeconds?: number;
  /**
   * Caller-controlled abort signal. Aborting it forwards SIGINT to pi,
   * waits 5s for graceful exit, then SIGKILLs.
   */
  readonly signal?: AbortSignal;
}

/** Default invocation timeout when neither flag nor manifest sets one. */
export const DEFAULT_INVOKE_TIMEOUT_S = 600;
/** Hard SIGKILL grace after the initial SIGINT. */
const KILL_GRACE_MS = 5000;

export interface InvokerShape {
  readonly invoke: (
    agentName: string,
    task: string,
    opts?: InvokeOptions,
  ) => Effect.Effect<InvokeResult, InvokerError>;
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
      const envResolver = yield* EnvResolver;
      const aliasStore = yield* AliasStore;
      const logStore = yield* LogStore;
      return {
        invoke: (name, task, opts) =>
          Effect.gen(function* () {
            const invocationId = randomUUID();
            const startedAt = Date.now();

            // Validate flag combination first — invalid input must short-circuit.
            if (opts?.cwd !== undefined && opts?.sandbox === true) {
              return yield* Effect.fail(
                new InvokeInvalidArgsError({
                  message: "--cwd and --sandbox are mutually exclusive",
                }),
              );
            }

            // If --cwd: assert path exists. The fs.access throw maps to a
            // tagged error with exit-2 semantics in the CLI.
            if (opts?.cwd !== undefined) {
              const exists = yield* Effect.tryPromise({
                try: () =>
                  fsp
                    .stat(opts.cwd as string)
                    .then((s) => s.isDirectory())
                    .catch(() => false),
                catch: () => false,
              }).pipe(Effect.orElseSucceed(() => false));
              if (!exists) {
                return yield* Effect.fail(
                  new InvokeCwdNotFoundError({
                    cwd: opts.cwd,
                    message: `--cwd path does not exist or is not a directory: ${opts.cwd}`,
                  }),
                );
              }
            }

            // Resolve aliases first; falls through to the supplied name when
            // no alias is set.
            const canonical = yield* aliasStore.resolve(name);
            const entry = yield* lookupRegistry(registry, canonical);
            const binary = yield* runtime.ensureSlot(entry.piSlot);
            const profile = paths.agentProfile(agentRootOf(canonical));
            const allowlist = entry.envDeclared.length > 0 ? entry.envDeclared : undefined;
            const resolved = yield* envResolver.resolve(agentRootOf(canonical), allowlist);
            // PI_CODING_AGENT_DIR / PI_PACKAGE_DIR are PiHub plumbing — they
            // override any value the resolver layers might have set so the
            // profile-isolation invariant from CONTEXT.md holds.
            const env: Record<string, string> = {
              ...resolved,
              PI_CODING_AGENT_DIR: profile,
              PI_PACKAGE_DIR: path.join(profile, "packages"),
            };

            // Sandbox mode: acquire-release temp dir. Cleanup is wired to the
            // Effect scope so it runs on success, failure, and interruption.
            const cwdResource = opts?.sandbox
              ? Effect.acquireRelease(
                  Effect.tryPromise({
                    try: () => fsp.mkdtemp(path.join(os.tmpdir(), "pihub-sandbox-")),
                    catch: (e) =>
                      new InvokeSpawnError({
                        binary,
                        message: `failed to create sandbox tempdir: ${String(e)}`,
                      }),
                  }),
                  (dir) =>
                    Effect.promise(() => fsp.rm(dir, { recursive: true, force: true })).pipe(
                      Effect.ignore,
                    ),
                )
              : Effect.succeed(opts?.cwd ?? process.cwd());

            // Resolve timeout: --timeout opt > registry's manifest value > default 600s.
            const timeoutSeconds =
              opts?.timeoutSeconds ?? entry.timeoutSeconds ?? DEFAULT_INVOKE_TIMEOUT_S;
            const timeoutMs = Math.max(1, Math.floor(timeoutSeconds * 1000));
            const externalSignal = opts?.signal;

            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const cwd = yield* cwdResource;
                return yield* Effect.tryPromise({
                  try: () =>
                    new Promise<{
                      stdout: string;
                      stderr: string;
                      exitCode: number;
                      terminationReason: TerminationReason;
                    }>((resolve, reject) => {
                      const child = spawn(binary, ["--mode", "json", "--no-session", "-p", task], {
                        env,
                        cwd,
                        stdio: ["ignore", "pipe", "pipe"],
                      });
                      const stdoutChunks: Buffer[] = [];
                      const stderrChunks: Buffer[] = [];
                      let termination: TerminationReason = null;
                      let killTimer: ReturnType<typeof setTimeout> | null = null;
                      const startKill = (cause: TerminationReason) => {
                        if (termination !== null) return;
                        termination = cause;
                        try {
                          child.kill("SIGINT");
                        } catch {
                          // child may already be dead; ignore
                        }
                        killTimer = setTimeout(() => {
                          try {
                            if (!child.killed) child.kill("SIGKILL");
                          } catch {
                            // ignore
                          }
                        }, KILL_GRACE_MS);
                      };
                      const timeoutTimer = setTimeout(() => startKill("timeout"), timeoutMs);
                      const onAbort = () => startKill("abort");
                      if (externalSignal) {
                        if (externalSignal.aborted) onAbort();
                        else externalSignal.addEventListener("abort", onAbort, { once: true });
                      }
                      child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
                      child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
                      child.on("error", (e) => {
                        clearTimeout(timeoutTimer);
                        if (killTimer) clearTimeout(killTimer);
                        if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
                        reject(e);
                      });
                      child.on("close", (code) => {
                        clearTimeout(timeoutTimer);
                        if (killTimer) clearTimeout(killTimer);
                        if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
                        let finalExit: number;
                        if (termination === "timeout") finalExit = 124;
                        else if (termination === "abort") finalExit = 130;
                        else finalExit = code ?? 1;
                        resolve({
                          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
                          stderr: Buffer.concat(stderrChunks).toString("utf8"),
                          exitCode: finalExit,
                          terminationReason: termination,
                        });
                      });
                    }),
                  catch: (e) =>
                    new InvokeSpawnError({ binary, message: `spawn failed: ${String(e)}` }),
                });
              }),
            );
            const agg = aggregate(result.stdout);
            const text = result.exitCode === 0 ? agg.text : "";
            const durationMs = Date.now() - startedAt;

            // Persist invocation log + ring-buffer prune. Failures here don't
            // change the user-visible result — observability is best-effort.
            yield* logStore
              .record({
                invocationId,
                agent: entry.name,
                startedAt: new Date(startedAt).toISOString(),
                durationMs,
                exitCode: result.exitCode,
                firstPromptLine: task.split(/\r?\n/, 1)[0] ?? "",
                raw: result.stdout,
              })
              .pipe(Effect.catchAll(() => Effect.void));
            yield* logStore
              .prune(entry.name, DEFAULT_LOG_RETENTION)
              .pipe(Effect.catchAll(() => Effect.void));

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
              terminationReason: result.terminationReason,
            } satisfies InvokeResult;
          }),
      } satisfies InvokerShape;
    }),
  );
}
