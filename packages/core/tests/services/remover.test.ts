import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { RegistryEntry } from "@pihub/schema";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Paths } from "../../src/paths.js";
import { AliasStore } from "../../src/services/alias-store.js";
import { LogStore } from "../../src/services/log-store.js";
import { RegistryStore } from "../../src/services/registry-store.js";
import { Remover } from "../../src/services/remover.js";

const sampleEntry = (name: string, piSlot = "0.74"): RegistryEntry => ({
  name,
  shape: "beta",
  piSlot,
  source: `/abs/${name}`,
  ref: "tree-abc",
  commitSha: "abc",
  description: "",
  invoke: `pihub invoke ${name} "<task>"`,
  envDeclared: [],
  linked: false,
  permissions: [],
});

const buildLayer = (
  homeDir: string,
  entries: ReadonlyArray<RegistryEntry>,
  aliases: ReadonlyMap<string, string> = new Map(),
) => {
  const Base = Layer.mergeAll(
    Paths.Test(homeDir),
    BunContext.layer,
    RegistryStore.Test(entries),
    AliasStore.Test(aliases),
    LogStore.Test(),
  );
  return Remover.Live.pipe(Layer.provideMerge(Base));
};

describe("Remover (live, real FS)", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-remove-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("removes agent dir, all sub-agent registry entries, dropped aliases", () =>
    Effect.gen(function* () {
      // Pre-seed the agent dir on disk.
      const agentDir = path.join(home, "agents", "owner/repo");
      yield* Effect.promise(() => fsp.mkdir(agentDir, { recursive: true }));
      yield* Effect.promise(() => fsp.writeFile(path.join(agentDir, "install.lock.json"), "{}"));

      const remover = yield* Remover;
      const result = yield* remover.remove("owner/repo");
      expect(result.agentRoot).toBe("owner/repo");
      expect([...result.removedEntries].sort()).toEqual(["owner/repo:planner", "owner/repo:scout"]);
      expect([...result.removedAliases].sort()).toEqual(["scout"]);

      // Disk gone.
      const stillExists = yield* Effect.promise(() =>
        fsp
          .stat(agentDir)
          .then(() => true)
          .catch(() => false),
      );
      expect(stillExists).toBe(false);

      // Registry entries gone.
      const registry = yield* RegistryStore;
      const reg = yield* registry.read;
      expect(reg.agents).toEqual([]);

      // Alias gone.
      const aliasStore = yield* AliasStore;
      const a = yield* aliasStore.read;
      expect(a.map["scout"]).toBeUndefined();
    }).pipe(
      Effect.provide(
        buildLayer(
          home,
          [sampleEntry("owner/repo:scout"), sampleEntry("owner/repo:planner")],
          new Map([
            ["scout", "owner/repo:scout"],
            ["other", "different/agent"],
          ]),
        ),
      ),
    ),
  );

  it.effect("alias resolution: invoke `pihub remove <alias>` works", () =>
    Effect.gen(function* () {
      const remover = yield* Remover;
      const result = yield* remover.remove("aws");
      expect(result.agentRoot).toBe("derek/aws-cost-tools");
    }).pipe(
      Effect.provide(
        buildLayer(
          home,
          [sampleEntry("derek/aws-cost-tools")],
          new Map([["aws", "derek/aws-cost-tools"]]),
        ),
      ),
    ),
  );

  it.effect("unknown agent → AgentNotFoundError", () =>
    Effect.gen(function* () {
      const remover = yield* Remover;
      const exit = yield* Effect.exit(remover.remove("nope"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("AgentNotFoundError");
    }).pipe(Effect.provide(buildLayer(home, []))),
  );

  it.effect("removes log files attributed to each sub-agent", () =>
    Effect.gen(function* () {
      const logStore = yield* LogStore;
      yield* logStore.record({
        invocationId: "log-1",
        agent: "owner/repo:scout",
        startedAt: "2026-05-09T01:00:00.000Z",
        durationMs: 10,
        exitCode: 0,
        firstPromptLine: "x",
        raw: "",
      });
      yield* logStore.record({
        invocationId: "log-2",
        agent: "other/keep",
        startedAt: "2026-05-09T01:00:00.000Z",
        durationMs: 10,
        exitCode: 0,
        firstPromptLine: "x",
        raw: "",
      });

      const remover = yield* Remover;
      const result = yield* remover.remove("owner/repo");
      expect(result.removedLogs).toBe(1);

      const after = yield* logStore.listForAgent("owner/repo:scout");
      expect(after).toEqual([]);
      const kept = yield* logStore.listForAgent("other/keep");
      expect(kept).toHaveLength(1);
    }).pipe(Effect.provide(buildLayer(home, [sampleEntry("owner/repo:scout")]))),
  );
});
