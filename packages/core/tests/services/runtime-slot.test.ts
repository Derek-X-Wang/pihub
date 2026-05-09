import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { RegistryEntry } from "@pihub/schema";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { BunInstallError } from "../../src/errors.js";
import { Paths } from "../../src/paths.js";
import { BunInstaller } from "../../src/services/bun-installer.js";
import { RegistryStore } from "../../src/services/registry-store.js";
import { RuntimeSlotManager } from "../../src/services/runtime-slot.js";

/**
 * Live RuntimeSlotManager + faked BunInstaller. The fake creates the
 * `node_modules/.bin/pi` file the manager polls for, so the success path
 * runs the full mkdir + package.json + install + binary-existence flow
 * without needing the network or a real bun resolver.
 */
const fakeInstaller = (slotDir: string) =>
  Layer.succeed(BunInstaller, {
    install: (cwd, dep) =>
      Effect.tryPromise({
        try: async () => {
          if (!cwd.startsWith(slotDir)) throw new Error(`unexpected cwd ${cwd}`);
          if (!dep.startsWith("@mariozechner/pi-coding-agent"))
            throw new Error(`unexpected dep ${dep}`);
          const binDir = path.join(cwd, "node_modules", ".bin");
          await fsp.mkdir(binDir, { recursive: true });
          await fsp.writeFile(path.join(binDir, "pi"), "#!/bin/sh\nexit 0\n", {
            mode: 0o755,
          });
        },
        catch: (e) => new BunInstallError({ cwd, dep, message: String(e) }),
      }),
  });

const buildLiveLayer = (homeDir: string, registryEntries: ReadonlyArray<RegistryEntry> = []) =>
  RuntimeSlotManager.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Paths.Test(homeDir),
        BunContext.layer,
        fakeInstaller(homeDir),
        RegistryStore.Test(registryEntries),
      ),
    ),
  );

describe("RuntimeSlotManager (live, faked BunInstaller)", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-runtime-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("ensureSlot installs Pi into the slot dir and returns the binary path", () =>
    Effect.gen(function* () {
      const manager = yield* RuntimeSlotManager;
      const binPath = yield* manager.ensureSlot("0.74");
      const expected = path.join(home, "runtime", "pi", "0.74", "node_modules", ".bin", "pi");
      expect(binPath).toBe(expected);
      const exists = yield* Effect.promise(() =>
        fsp
          .access(binPath)
          .then(() => true)
          .catch(() => false),
      );
      expect(exists).toBe(true);

      // package.json was seeded
      const pkg = JSON.parse(
        yield* Effect.promise(() =>
          fsp.readFile(path.join(home, "runtime", "pi", "0.74", "package.json"), "utf8"),
        ),
      );
      expect(pkg.name).toBe("pihub-pi-slot");
    }).pipe(Effect.provide(buildLiveLayer(home))),
  );

  it.effect("ensureSlot is idempotent: second call skips install", () =>
    Effect.gen(function* () {
      const manager = yield* RuntimeSlotManager;
      const first = yield* manager.ensureSlot("0.74");
      const stat1 = yield* Effect.promise(() => fsp.stat(first));
      const second = yield* manager.ensureSlot("0.74");
      const stat2 = yield* Effect.promise(() => fsp.stat(second));
      expect(second).toBe(first);
      // mtime is unchanged because the install branch is skipped.
      expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
    }).pipe(Effect.provide(buildLiveLayer(home))),
  );

  it.effect("listSlots reports refcount derived from registry entries", () =>
    Effect.gen(function* () {
      const manager = yield* RuntimeSlotManager;
      yield* manager.ensureSlot("0.74");
      yield* manager.ensureSlot("0.75");
      const list = yield* manager.listSlots;
      expect(list.map((s) => s.minor)).toEqual(["0.74", "0.75"]);
      // 2 entries on 0.74, 0 on 0.75 — refcount derived from the registry seed.
      const m = new Map(list.map((s) => [s.minor, s.refcount]));
      expect(m.get("0.74")).toBe(2);
      expect(m.get("0.75")).toBe(0);
      // Path round-trips through Paths.Test.
      expect(list[0]?.path).toContain("runtime/pi/0.74");
    }).pipe(
      Effect.provide(
        buildLiveLayer(home, [{ ...sampleEntry("a", "0.74") }, { ...sampleEntry("b", "0.74") }]),
      ),
    ),
  );

  it.effect("removeSlot fails when refcount > 0 (RuntimeSlotError)", () =>
    Effect.gen(function* () {
      const manager = yield* RuntimeSlotManager;
      yield* manager.ensureSlot("0.74");
      const exit = yield* Effect.exit(manager.removeSlot("0.74"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("RuntimeSlotError");
      expect(JSON.stringify(exit)).toContain("agent(s) pin it");
    }).pipe(Effect.provide(buildLiveLayer(home, [sampleEntry("a", "0.74")]))),
  );

  it.effect("removeSlot succeeds when refcount = 0", () =>
    Effect.gen(function* () {
      const manager = yield* RuntimeSlotManager;
      yield* manager.ensureSlot("0.74");
      yield* manager.removeSlot("0.74");
      const list = yield* manager.listSlots;
      expect(list).toEqual([]);
    }).pipe(Effect.provide(buildLiveLayer(home, []))),
  );

  it.effect("gc removes only unreferenced slots", () =>
    Effect.gen(function* () {
      const manager = yield* RuntimeSlotManager;
      yield* manager.ensureSlot("0.74");
      yield* manager.ensureSlot("0.75");
      const deleted = yield* manager.gc;
      expect([...deleted].sort()).toEqual(["0.75"]);
      const list = yield* manager.listSlots;
      expect(list.map((s) => s.minor)).toEqual(["0.74"]);
    }).pipe(Effect.provide(buildLiveLayer(home, [sampleEntry("a", "0.74")]))),
  );
});

const sampleEntry = (name: string, piSlot: string): RegistryEntry => ({
  name,
  shape: "alpha",
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
