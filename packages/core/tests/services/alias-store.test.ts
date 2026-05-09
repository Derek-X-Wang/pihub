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
import { RegistryStore } from "../../src/services/registry-store.js";

const sampleEntry: RegistryEntry = {
  name: "derek/aws-cost-tools",
  shape: "alpha",
  piSlot: "0.74",
  source: "/abs/derek/aws-cost-tools",
  ref: "tree-abc",
  commitSha: "abc",
  description: "aws cost",
  invoke: 'pihub invoke derek/aws-cost-tools "<task>"',
  envDeclared: [],
  linked: false,
  permissions: [],
};

const buildLayer = (homeDir: string, entries: ReadonlyArray<RegistryEntry>) =>
  AliasStore.Live.pipe(
    Layer.provide(
      Layer.mergeAll(Paths.Test(homeDir), BunContext.layer, RegistryStore.Test(entries)),
    ),
  );

describe("AliasStore (live, real FS)", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-alias-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("set + read round-trips through aliases.json", () =>
    Effect.gen(function* () {
      const store = yield* AliasStore;
      yield* store.set("aws-cost", "derek/aws-cost-tools");
      const a = yield* store.read;
      expect(a.map["aws-cost"]).toBe("derek/aws-cost-tools");
    }).pipe(Effect.provide(buildLayer(home, [sampleEntry]))),
  );

  it.effect("re-set on the same short name fails with AliasCollisionError", () =>
    Effect.gen(function* () {
      const store = yield* AliasStore;
      yield* store.set("aws-cost", "derek/aws-cost-tools");
      const exit = yield* Effect.exit(store.set("aws-cost", "other/agent"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("AliasCollisionError");
    }).pipe(Effect.provide(buildLayer(home, [sampleEntry]))),
  );

  it.effect("setting an alias that collides with a canonical name fails", () =>
    Effect.gen(function* () {
      const store = yield* AliasStore;
      const exit = yield* Effect.exit(store.set("derek/aws-cost-tools", "something-else"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("AliasCollisionError");
    }).pipe(Effect.provide(buildLayer(home, [sampleEntry]))),
  );

  it.effect("remove deletes; subsequent resolve falls through to the input", () =>
    Effect.gen(function* () {
      const store = yield* AliasStore;
      yield* store.set("aws-cost", "derek/aws-cost-tools");
      yield* store.remove("aws-cost");
      const resolved = yield* store.resolve("aws-cost");
      expect(resolved).toBe("aws-cost");
    }).pipe(Effect.provide(buildLayer(home, [sampleEntry]))),
  );

  it.effect("remove of non-existent alias → AliasNotFoundError", () =>
    Effect.gen(function* () {
      const store = yield* AliasStore;
      const exit = yield* Effect.exit(store.remove("missing"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("AliasNotFoundError");
    }).pipe(Effect.provide(buildLayer(home, [sampleEntry]))),
  );

  it.effect("resolve returns canonical for a known short, passes through otherwise", () =>
    Effect.gen(function* () {
      const store = yield* AliasStore;
      yield* store.set("aws-cost", "derek/aws-cost-tools");
      const a = yield* store.resolve("aws-cost");
      const b = yield* store.resolve("derek/aws-cost-tools");
      expect(a).toBe("derek/aws-cost-tools");
      expect(b).toBe("derek/aws-cost-tools");
    }).pipe(Effect.provide(buildLayer(home, [sampleEntry]))),
  );
});
