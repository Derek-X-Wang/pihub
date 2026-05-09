import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { RegistryEntry } from "@pihub/schema";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Paths } from "../../src/paths.js";
import { EnvResolver } from "../../src/services/env-resolver.js";
import type { InvokeOptions } from "../../src/services/invoker.js";
import { Invoker } from "../../src/services/invoker.js";
import { RegistryStore } from "../../src/services/registry-store.js";
import { RuntimeSlotManager } from "../../src/services/runtime-slot.js";

const sampleEntry: RegistryEntry = {
  name: "sample-beta-agent:scout",
  shape: "beta",
  piSlot: "0.74",
  source: "/abs/sample-beta-agent",
  ref: "tree-abc",
  commitSha: "abc",
  description: "scouts",
  invoke: 'pihub invoke sample-beta-agent:scout "<task>"',
  envDeclared: [],
  linked: false,
  permissions: [],
};

/**
 * Build a faux-pi shell script at `dir/pi` that:
 * - asserts PI_CODING_AGENT_DIR is set to `expectedProfile`
 * - writes the canned JSONL `events` to stdout
 * - exits with `exitCode`
 */
const writeFauxPi = async (
  dir: string,
  events: ReadonlyArray<string>,
  exitCode: number,
  expectedProfile: string,
): Promise<string> => {
  await fsp.mkdir(dir, { recursive: true });
  const binPath = path.join(dir, "pi");
  const lines = [
    "#!/usr/bin/env bash",
    "set -e",
    `if [ "$PI_CODING_AGENT_DIR" != "${expectedProfile}" ]; then`,
    '  echo "missing or wrong PI_CODING_AGENT_DIR: $PI_CODING_AGENT_DIR" >&2',
    "  exit 99",
    "fi",
    `if [ -z "$PI_PACKAGE_DIR" ]; then`,
    '  echo "missing PI_PACKAGE_DIR" >&2',
    "  exit 99",
    "fi",
    ...events.map((e) => `printf '%s\\n' '${e.replace(/'/g, "'\"'\"'")}'`),
    `exit ${exitCode}`,
  ];
  await fsp.writeFile(binPath, lines.join("\n") + "\n", { mode: 0o755 });
  return binPath;
};

const buildLayer = (
  homeDir: string,
  binaryPath: string,
  entries: ReadonlyArray<RegistryEntry>,
  resolverSeed?: ReadonlyMap<string, Record<string, string>>,
) =>
  Invoker.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Paths.Test(homeDir),
        BunContext.layer,
        RegistryStore.Test(entries),
        RuntimeSlotManager.Test(new Map([["0.74", binaryPath]])),
        EnvResolver.Test(resolverSeed),
      ),
    ),
  );

describe("Invoker (live spawn against faux-pi shell script)", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-invoker-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("env injection happens, JSONL parses, final assistant text returned", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      yield* Effect.promise(() =>
        writeFauxPi(
          path.join(home, "fakebin"),
          [
            JSON.stringify({ type: "session", id: "abc" }),
            JSON.stringify({ type: "agent_start" }),
            JSON.stringify({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Hello from faux-pi" }],
              },
            }),
            JSON.stringify({ type: "agent_end", messages: [] }),
          ],
          0,
          profile,
        ),
      );
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping");
      expect(result.exitCode).toBe(0);
      expect(result.text).toBe("Hello from faux-pi");
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("multiple message_end events → returns the LAST assistant text", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      yield* Effect.promise(() =>
        writeFauxPi(
          path.join(home, "fakebin"),
          [
            JSON.stringify({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "first" }] },
            }),
            JSON.stringify({
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "second" }] },
            }),
          ],
          0,
          profile,
        ),
      );
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping");
      expect(result.text).toBe("second");
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("non-zero pi exit code is forwarded as exitCode", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      yield* Effect.promise(() =>
        writeFauxPi(
          path.join(home, "fakebin"),
          [JSON.stringify({ type: "session", id: "abc" })],
          7,
          profile,
        ),
      );
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping");
      expect(result.exitCode).toBe(7);
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("AgentNotFoundError when the registry has no entry", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      yield* Effect.promise(() => writeFauxPi(path.join(home, "fakebin"), [], 0, profile));
      const invoker = yield* Invoker;
      const exit = yield* Effect.exit(invoker.invoke("nope", "ping"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("AgentNotFoundError");
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), []))),
  );

  it.effect("--stream-mode raw passthrough — every emitted line is preserved verbatim", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      const events = [
        JSON.stringify({ type: "session", id: "abc" }),
        JSON.stringify({ type: "agent_start" }),
        JSON.stringify({
          type: "tool_execution_start",
          toolCallId: "t1",
          toolName: "bash",
          args: { cmd: "echo" },
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "stream pass-through OK" }],
          },
        }),
        JSON.stringify({ type: "agent_end", messages: [] }),
      ];
      yield* Effect.promise(() => writeFauxPi(path.join(home, "fakebin"), events, 0, profile));
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping");
      // Raw stdout should contain every event in order, one per line.
      const lines = result.raw.trim().split(/\r?\n/);
      expect(lines).toEqual(events);
      // Default text projection still extracts the final assistant text.
      expect(result.text).toBe("stream pass-through OK");
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("envelope aggregates: invocationId, durationMs, sessionId, usage, toolCalls", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      const events = [
        JSON.stringify({ type: "session", id: "session-xyz" }),
        JSON.stringify({
          type: "tool_execution_end",
          toolCallId: "t1",
          toolName: "bash",
          result: {},
          isError: false,
        }),
        JSON.stringify({
          type: "tool_execution_end",
          toolCallId: "t2",
          toolName: "read",
          result: {},
          isError: true,
        }),
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "all done" }],
            stopReason: "stop",
            usage: { input: 100, output: 50, cost: 0.001 },
          },
        }),
      ];
      yield* Effect.promise(() => writeFauxPi(path.join(home, "fakebin"), events, 0, profile));
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping");
      expect(result.exitCode).toBe(0);
      expect(result.invocationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.sessionId).toBe("session-xyz");
      expect(result.usage).toEqual({ input: 100, output: 50, cost: 0.001 });
      expect(result.toolCalls).toEqual([
        { name: "bash", ok: true },
        { name: "read", ok: false },
      ]);
      expect(result.stopReason).toBe("stop");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("error mapping: stopReason 'error' with no keyword → llm_error envelope", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      const events = [
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "partial output" }],
            stopReason: "error",
            errorMessage: "model returned malformed response",
          },
        }),
      ];
      yield* Effect.promise(() => writeFauxPi(path.join(home, "fakebin"), events, 1, profile));
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping");
      expect(result.exitCode).toBe(1);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("malformed");
      expect(result.lastAssistantMessage).toBe("partial output");
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("error mapping: errorMessage with 'tool' keyword → tool_error envelope", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      const events = [
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "tool execution failed",
          },
        }),
      ];
      yield* Effect.promise(() => writeFauxPi(path.join(home, "fakebin"), events, 1, profile));
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping");
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("tool");
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("runtime_error path: missing pi binary surfaces as InvokeSpawnError", () =>
    Effect.gen(function* () {
      const invoker = yield* Invoker;
      const exit = yield* Effect.exit(invoker.invoke("sample-beta-agent:scout", "ping"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("InvokeSpawnError");
    }).pipe(
      Effect.provide(buildLayer(home, path.join(home, "does-not-exist", "pi"), [sampleEntry])),
    ),
  );

  it.effect("--cwd: pi inherits the supplied cwd", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      const cwdPath = path.join(home, "explicit-cwd");
      yield* Effect.promise(() => fsp.mkdir(cwdPath, { recursive: true }));
      // Faux-pi prints its own pwd as a side-channel so the test can verify.
      const binDir = path.join(home, "fakebin");
      const pi = path.join(binDir, "pi");
      yield* Effect.promise(async () => {
        await fsp.mkdir(binDir, { recursive: true });
        await fsp.writeFile(
          pi,
          [
            "#!/usr/bin/env bash",
            `if [ "$PI_CODING_AGENT_DIR" != "${profile}" ]; then exit 99; fi`,
            'printf "%s\\n" "{\\"type\\":\\"cwd-marker\\",\\"cwd\\":\\"$(pwd)\\"}"',
            'printf "%s\\n" "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"ok\\"}]}}"',
            "exit 0",
          ].join("\n"),
          { mode: 0o755 },
        );
      });
      const realCwdPath = yield* Effect.promise(() => fsp.realpath(cwdPath));
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping", { cwd: cwdPath });
      expect(result.exitCode).toBe(0);
      // macOS symlinks /var → /private/var; compare resolved real paths.
      expect(result.raw).toContain(`"cwd":"${realCwdPath}"`);
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("--cwd: non-existent path → InvokeCwdNotFoundError", () =>
    Effect.gen(function* () {
      const invoker = yield* Invoker;
      const exit = yield* Effect.exit(
        invoker.invoke("sample-beta-agent:scout", "ping", { cwd: "/nope/does-not-exist" }),
      );
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("InvokeCwdNotFoundError");
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("--cwd + --sandbox together → InvokeInvalidArgsError", () =>
    Effect.gen(function* () {
      const invoker = yield* Invoker;
      const exit = yield* Effect.exit(
        invoker.invoke("sample-beta-agent:scout", "ping", { cwd: "/tmp", sandbox: true }),
      );
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("InvokeInvalidArgsError");
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect("--sandbox: tempdir created under tmpdir; removed after exit", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      // Faux-pi captures its cwd so the test can later verify it doesn't survive.
      const binDir = path.join(home, "fakebin");
      const pi = path.join(binDir, "pi");
      yield* Effect.promise(async () => {
        await fsp.mkdir(binDir, { recursive: true });
        await fsp.writeFile(
          pi,
          [
            "#!/usr/bin/env bash",
            `if [ "$PI_CODING_AGENT_DIR" != "${profile}" ]; then exit 99; fi`,
            'printf "%s\\n" "{\\"type\\":\\"cwd-marker\\",\\"cwd\\":\\"$(pwd)\\"}"',
            'printf "%s\\n" "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"ok\\"}]}}"',
            "exit 0",
          ].join("\n"),
          { mode: 0o755 },
        );
      });
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping", { sandbox: true });
      expect(result.exitCode).toBe(0);
      // Pull the recorded cwd back out of the JSONL marker line.
      const match = result.raw.match(/"cwd":"([^"]+)"/);
      expect(match).not.toBeNull();
      const sandboxCwd = match?.[1] as string;
      expect(sandboxCwd).toContain("pihub-sandbox-");
      // After the invocation completes, the tempdir is gone.
      const stillExists = yield* Effect.promise(() =>
        fsp
          .stat(sandboxCwd)
          .then(() => true)
          .catch(() => false),
      );
      expect(stillExists).toBe(false);
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );

  it.effect(
    "--timeout: faux-pi sleeps; pi killed; exit 124",
    () =>
      Effect.gen(function* () {
        const profile = path.join(home, "agents", "sample-beta-agent", "profile");
        const binDir = path.join(home, "fakebin");
        const pi = path.join(binDir, "pi");
        // Use a python-style trap-and-exit so SIGINT actually gets handled
        // promptly. (bash's trap-during-sleep sometimes waits for sleep to
        // return before running the handler, blowing past the test deadline.)
        yield* Effect.promise(async () => {
          await fsp.mkdir(binDir, { recursive: true });
          await fsp.writeFile(
            pi,
            [
              "#!/usr/bin/env bash",
              `if [ "$PI_CODING_AGENT_DIR" != "${profile}" ]; then exit 99; fi`,
              // Background sleep + wait pattern: bash receives SIGINT, kills",
              // the background sleep via `kill 0`, trap fires immediately.",
              "sleep 30 &",
              "PID=$!",
              "trap 'kill $PID 2>/dev/null; exit 130' INT TERM",
              "wait $PID",
              "exit 0",
            ].join("\n"),
            { mode: 0o755 },
          );
        });
        const invoker = yield* Invoker;
        const result = yield* invoker.invoke("sample-beta-agent:scout", "ping", {
          timeoutSeconds: 1,
        } as InvokeOptions);
        expect(result.terminationReason).toBe("timeout");
        expect(result.exitCode).toBe(124);
      }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
    15000,
  );

  it.effect(
    "abort: caller AbortSignal forwards to pi; exit 130",
    () =>
      Effect.gen(function* () {
        const profile = path.join(home, "agents", "sample-beta-agent", "profile");
        const binDir = path.join(home, "fakebin");
        const pi = path.join(binDir, "pi");
        yield* Effect.promise(async () => {
          await fsp.mkdir(binDir, { recursive: true });
          await fsp.writeFile(
            pi,
            [
              "#!/usr/bin/env bash",
              `if [ "$PI_CODING_AGENT_DIR" != "${profile}" ]; then exit 99; fi`,
              "sleep 30 &",
              "PID=$!",
              "trap 'kill $PID 2>/dev/null; exit 130' INT TERM",
              "wait $PID",
            ].join("\n"),
            { mode: 0o755 },
          );
        });
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 200);
        const invoker = yield* Invoker;
        const result = yield* invoker.invoke("sample-beta-agent:scout", "ping", {
          signal: ac.signal,
          timeoutSeconds: 60,
        } as InvokeOptions);
        expect(result.terminationReason).toBe("abort");
        expect(result.exitCode).toBe(130);
      }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
    15000,
  );

  it.effect(
    "manifest timeoutSeconds is the fallback when --timeout is not set",
    () =>
      Effect.gen(function* () {
        const profile = path.join(home, "agents", "sample-beta-agent", "profile");
        const binDir = path.join(home, "fakebin");
        const pi = path.join(binDir, "pi");
        yield* Effect.promise(async () => {
          await fsp.mkdir(binDir, { recursive: true });
          await fsp.writeFile(
            pi,
            [
              "#!/usr/bin/env bash",
              `if [ "$PI_CODING_AGENT_DIR" != "${profile}" ]; then exit 99; fi`,
              "sleep 30 &",
              "PID=$!",
              "trap 'kill $PID 2>/dev/null; exit 130' INT TERM",
              "wait $PID",
            ].join("\n"),
            { mode: 0o755 },
          );
        });
        const invoker = yield* Invoker;
        const result = yield* invoker.invoke("sample-beta-agent:scout", "ping");
        expect(result.terminationReason).toBe("timeout");
        expect(result.exitCode).toBe(124);
      }).pipe(
        Effect.provide(
          buildLayer(home, path.join(home, "fakebin", "pi"), [
            { ...sampleEntry, timeoutSeconds: 1 },
          ]),
        ),
      ),
    15000,
  );

  it.effect("--sandbox: tempdir cleanup runs even when pi exits non-zero", () =>
    Effect.gen(function* () {
      const profile = path.join(home, "agents", "sample-beta-agent", "profile");
      const binDir = path.join(home, "fakebin");
      const pi = path.join(binDir, "pi");
      yield* Effect.promise(async () => {
        await fsp.mkdir(binDir, { recursive: true });
        await fsp.writeFile(
          pi,
          [
            "#!/usr/bin/env bash",
            `if [ "$PI_CODING_AGENT_DIR" != "${profile}" ]; then exit 99; fi`,
            'printf "%s\\n" "{\\"type\\":\\"cwd-marker\\",\\"cwd\\":\\"$(pwd)\\"}"',
            "exit 1",
          ].join("\n"),
          { mode: 0o755 },
        );
      });
      const invoker = yield* Invoker;
      const result = yield* invoker.invoke("sample-beta-agent:scout", "ping", { sandbox: true });
      expect(result.exitCode).toBe(1);
      const match = result.raw.match(/"cwd":"([^"]+)"/);
      expect(match).not.toBeNull();
      const sandboxCwd = match?.[1] as string;
      const stillExists = yield* Effect.promise(() =>
        fsp
          .stat(sandboxCwd)
          .then(() => true)
          .catch(() => false),
      );
      expect(stillExists).toBe(false);
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi"), [sampleEntry]))),
  );
});
