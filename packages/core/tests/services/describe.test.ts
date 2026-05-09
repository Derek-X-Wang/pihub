import { it } from "@effect/vitest";
import { Lockfile, Registry, RegistryEntry } from "@pihub/schema";
import { Effect, Layer, Schema } from "effect";
import { describe, expect } from "vitest";
import { Describe } from "../../src/services/describe.js";
import { LockfileStore } from "../../src/services/lockfile-store.js";
import { RegistryStore } from "../../src/services/registry-store.js";

const sampleEntry: RegistryEntry = {
  name: "sample-beta-agent:scout",
  shape: "beta",
  piSlot: "default",
  source: "/abs/sample-beta-agent",
  ref: "tree-abc",
  commitSha: "abc",
  description: "scouts",
  invoke: 'pihub invoke sample-beta-agent:scout "<task>"',
  envDeclared: ["ANTHROPIC_API_KEY"],
  linked: false,
  permissions: [],
};

const sampleLock: Lockfile = {
  source: "/abs/sample-beta-agent",
  ref: "tree-abc",
  commitSha: "abc",
  piSlot: "default",
  depsLockSha: "",
  installedAt: "2026-05-09T00:00:00.000Z",
  link: false,
};

const buildLayer = (entries: ReadonlyArray<RegistryEntry>, locks: Map<string, Lockfile>) =>
  Describe.Live.pipe(
    Layer.provide(Layer.mergeAll(RegistryStore.Test(entries), LockfileStore.Test(locks))),
  );

describe("Describe service", () => {
  it.effect("returns AgentDescription for a known sub-agent", () =>
    Effect.gen(function* () {
      const describe = yield* Describe;
      const desc = yield* describe.describe("sample-beta-agent:scout");
      expect(desc.name).toBe("sample-beta-agent:scout");
      expect(desc.installedAt).toBe("2026-05-09T00:00:00.000Z");
      expect(desc.depsLockSha).toBe("");
      expect(desc.envDeclared).toEqual(["ANTHROPIC_API_KEY"]);
    }).pipe(
      Effect.provide(buildLayer([sampleEntry], new Map([["sample-beta-agent", sampleLock]]))),
    ),
  );

  it.effect("fails with AgentNotFoundError for an unknown name", () =>
    Effect.gen(function* () {
      const describe = yield* Describe;
      const exit = yield* Effect.exit(describe.describe("does-not-exist"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("AgentNotFoundError");
      expect(JSON.stringify(exit)).toContain("pihub list");
    }).pipe(Effect.provide(buildLayer([], new Map()))),
  );

  it.effect("strips :sub from the lockfile lookup key", () =>
    Effect.gen(function* () {
      // Lockfile is keyed at the agent root (no `:sub`).
      const describe = yield* Describe;
      const desc = yield* describe.describe("sample-beta-agent:scout");
      expect(desc.installedAt).toBe(sampleLock.installedAt);
    }).pipe(
      Effect.provide(buildLayer([sampleEntry], new Map([["sample-beta-agent", sampleLock]]))),
    ),
  );

  it.effect("registry has entry but lockfile missing → AgentNotFoundError", () =>
    Effect.gen(function* () {
      const describe = yield* Describe;
      const exit = yield* Effect.exit(describe.describe("sample-beta-agent:scout"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("AgentNotFoundError");
      expect(JSON.stringify(exit)).toContain("re-run");
    }).pipe(Effect.provide(buildLayer([sampleEntry], new Map()))),
  );
});

describe("Registry --json shape", () => {
  it.effect("registry contents validate against the Registry schema", () =>
    Effect.gen(function* () {
      const registry = yield* RegistryStore;
      const reg = yield* registry.read;
      const json = JSON.stringify(reg);
      // Round-trip through the schema decoder to assert the produced JSON
      // matches the `Registry` shape advertised in @pihub/schema.
      const decoded = yield* Schema.decodeUnknown(Schema.parseJson(Registry))(json);
      expect(decoded.agents).toHaveLength(1);
      expect(decoded.agents[0]?.name).toBe("sample-beta-agent:scout");
    }).pipe(Effect.provide(RegistryStore.Test([sampleEntry]))),
  );
});
