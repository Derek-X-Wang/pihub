import { spawn } from "node:child_process";
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

export interface InvokeResult {
  readonly text: string;
  readonly exitCode: number;
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

/** Minimal slice of a pi `--mode json` `message_end` event that we read. */
const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const MessageEnd = Schema.Struct({
  type: Schema.Literal("message_end"),
  message: Schema.Struct({
    role: Schema.String,
    // `content` is a heterogeneous array; we only care about text blocks.
    content: Schema.Array(Schema.Unknown),
  }),
});

const decodeMessageEnd = Schema.decodeUnknown(MessageEnd);
const decodeTextContent = Schema.decodeUnknown(TextContent);

/**
 * Concatenate the `text` field from any TextContent blocks in a content array.
 * Pi may emit `text`, `thinking`, or `toolCall` blocks; only `text` is what
 * the default-mode CLI prints (matching `pi -p` semantics).
 */
const extractText = (content: ReadonlyArray<unknown>): string => {
  const parts: string[] = [];
  for (const block of content) {
    const decoded = Effect.runSyncExit(decodeTextContent(block));
    if (decoded._tag === "Success") parts.push(decoded.value.text);
  }
  return parts.join("");
};

/**
 * Walk a JSONL `pi --mode json` stream and return the assistant text from
 * the LAST `message_end` whose message.role === "assistant". Mirrors
 * `pi -p` behaviour where the user only sees the final assistant text.
 */
const finalAssistantText = (stdout: string): string => {
  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) continue;
    const result = Effect.runSyncExit(
      Effect.gen(function* () {
        const raw = yield* Effect.try({
          try: () => JSON.parse(line) as unknown,
          catch: () => null,
        });
        if (raw === null) return null;
        const isMsgEnd =
          typeof raw === "object" &&
          raw !== null &&
          (raw as { type?: unknown }).type === "message_end";
        if (!isMsgEnd) return null;
        const me = yield* decodeMessageEnd(raw);
        if (me.message.role !== "assistant") return null;
        return extractText(me.message.content);
      }),
    );
    if (result._tag === "Success" && result.value !== null) {
      last = result.value;
    }
  }
  return last;
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
            if (result.exitCode !== 0) {
              // Forward stderr as our error message; preserve exitCode for the
              // CLI to translate into a process exit code.
              return {
                text: result.stderr.trim(),
                exitCode: result.exitCode,
              } satisfies InvokeResult;
            }
            const text = finalAssistantText(result.stdout);
            return { text, exitCode: 0 } satisfies InvokeResult;
          }),
      } satisfies InvokerShape;
    }),
  );
}
