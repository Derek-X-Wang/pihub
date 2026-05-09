import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { BunInstallError } from "../../src/errors.js";
import { Paths } from "../../src/paths.js";
import { BunInstaller } from "../../src/services/bun-installer.js";
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

const buildLiveLayer = (homeDir: string) =>
  RuntimeSlotManager.Live.pipe(
    Layer.provide(Layer.mergeAll(Paths.Test(homeDir), BunContext.layer, fakeInstaller(homeDir))),
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
});
