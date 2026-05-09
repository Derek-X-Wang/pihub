import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { RegistryEntry } from "@pihub/schema";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Paths } from "../../src/paths.js";
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

const buildLayer = (homeDir: string, binaryPath: string, entries: ReadonlyArray<RegistryEntry>) =>
  Invoker.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Paths.Test(homeDir),
        BunContext.layer,
        RegistryStore.Test(entries),
        RuntimeSlotManager.Test(new Map([["0.74", binaryPath]])),
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
});
