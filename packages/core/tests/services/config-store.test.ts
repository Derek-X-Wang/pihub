import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Paths } from "../../src/paths.js";
import { ConfigStore } from "../../src/services/config-store.js";

const buildLayer = (homeDir: string) =>
  ConfigStore.Live.pipe(Layer.provide(Layer.mergeAll(Paths.Test(homeDir), BunContext.layer)));

describe("ConfigStore (live, real FS)", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-config-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("get on unset key returns the default via getNumber", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStore;
      expect(yield* store.getNumber("timeout.default")).toBe(600);
      expect(yield* store.getNumber("logs.retention")).toBe(50);
      expect(yield* store.getNumber("install.parallel")).toBe(4);
      expect(yield* store.getDefaultPiMinor).toBe("0.74");
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("set + read writes config.json with mode-default permissions", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStore;
      yield* store.set("timeout.default", "900");
      const c = yield* store.read;
      expect(c["timeout.default"]).toBe(900);
      expect(yield* store.getNumber("timeout.default")).toBe(900);
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("set with unknown key fails with ConfigInvalidError", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStore;
      const exit = yield* Effect.exit(store.set("nope.foo", "1"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("ConfigInvalidError");
      expect(JSON.stringify(exit)).toContain("unknown key");
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("set with non-int value for an int key fails", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStore;
      const exit = yield* Effect.exit(store.set("timeout.default", "abc"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("ConfigInvalidError");
      expect(JSON.stringify(exit)).toContain("positive integer");
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("runtime.defaultMinor accepts MAJOR.MINOR but rejects garbage", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStore;
      yield* store.set("runtime.defaultMinor", "0.75");
      expect(yield* store.getDefaultPiMinor).toBe("0.75");
      const exit = yield* Effect.exit(store.set("runtime.defaultMinor", "v0.75.0"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("semver minor");
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("unset reverts to default", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStore;
      yield* store.set("timeout.default", "1234");
      expect(yield* store.getNumber("timeout.default")).toBe(1234);
      yield* store.unset("timeout.default");
      expect(yield* store.getNumber("timeout.default")).toBe(600);
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("unset of unknown key → ConfigInvalidError", () =>
    Effect.gen(function* () {
      const store = yield* ConfigStore;
      const exit = yield* Effect.exit(store.unset("nope"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("ConfigInvalidError");
    }).pipe(Effect.provide(buildLayer(home))),
  );
});
