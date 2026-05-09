import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import {
  AliasStore,
  EnvResolver,
  EphemeralRunner,
  GitClient,
  GithubApi,
  Invoker,
  LogStore,
  ManifestParser,
  NpmRegistry,
  Paths,
  PiInstaller,
  RegistryStore,
  RuntimeSlotManager,
  ShapeDetector,
  SourceFetcher,
  TarExtractor,
} from "@pihub/core";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "..", "test", "fixtures", "sample-beta-agent");

const buildLayer = (homeDir: string, binaryPath: string) => {
  const Base = Layer.mergeAll(
    Paths.Test(homeDir),
    BunContext.layer,
    GithubApi.Test(),
    GitClient.Test(),
    NpmRegistry.Test(),
    TarExtractor.Test(),
    RuntimeSlotManager.Test(new Map([["*", binaryPath]])),
    PiInstaller.Test(),
    AliasStore.Test(),
    LogStore.Test(),
    EnvResolver.Test(),
    RegistryStore.Test(),
  );
  const Leaves = Layer.mergeAll(
    ShapeDetector.Live,
    ManifestParser.Live,
    SourceFetcher.Live,
    Invoker.Live,
  ).pipe(Layer.provideMerge(Base));
  // Expose Base + Invoker outputs *and* EphemeralRunner so tests can assert
  // post-run state (e.g. that RegistryStore stayed empty).
  return EphemeralRunner.Live.pipe(Layer.provideMerge(Leaves));
};

describe("EphemeralRunner (live, faux-pi shell script)", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-run-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("happy path: copies fixture, runs faux-pi, cleans up tempdir", () =>
    Effect.gen(function* () {
      const binDir = path.join(home, "fakebin");
      const pi = path.join(binDir, "pi");
      yield* Effect.promise(async () => {
        await fsp.mkdir(binDir, { recursive: true });
        await fsp.writeFile(
          pi,
          [
            "#!/usr/bin/env bash",
            'printf "%s\\n" "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"ran ephemerally\\"}]}}"',
            "exit 0",
          ].join("\n"),
          { mode: 0o755 },
        );
      });

      const runner = yield* EphemeralRunner;
      const result = yield* runner.run(FIXTURE, "ping");
      expect(result.exitCode).toBe(0);
      expect(result.text).toBe("ran ephemerally");

      // Ephemeral root removed after the run completes.
      const ephRoot = path.join(home, "runtime", "ephemeral");
      const stillExists = yield* Effect.promise(() =>
        fsp
          .stat(ephRoot)
          .then((s) => s.isDirectory())
          .catch(() => false),
      );
      // Either gone entirely or empty — Effect.scoped released our uuid'd
      // subdir and we never created any sibling.
      if (stillExists) {
        const entries = yield* Effect.promise(() => fsp.readdir(ephRoot));
        expect(entries).toEqual([]);
      }

      // Registry never gets an entry for an ephemeral run.
      const registry = yield* RegistryStore;
      const reg = yield* registry.read;
      expect(reg.agents).toEqual([]);
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi")))),
  );

  it.effect("cleanup runs even when pi exits non-zero", () =>
    Effect.gen(function* () {
      const binDir = path.join(home, "fakebin");
      const pi = path.join(binDir, "pi");
      yield* Effect.promise(async () => {
        await fsp.mkdir(binDir, { recursive: true });
        await fsp.writeFile(pi, ["#!/usr/bin/env bash", 'echo "boom" >&2', "exit 1"].join("\n"), {
          mode: 0o755,
        });
      });

      const runner = yield* EphemeralRunner;
      const result = yield* runner.run(FIXTURE, "ping");
      expect(result.exitCode).toBe(1);

      // Ephemeral root still cleaned despite the non-zero exit.
      const ephRoot = path.join(home, "runtime", "ephemeral");
      const exists = yield* Effect.promise(() =>
        fsp
          .stat(ephRoot)
          .then(() => true)
          .catch(() => false),
      );
      if (exists) {
        const entries = yield* Effect.promise(() => fsp.readdir(ephRoot));
        expect(entries).toEqual([]);
      }
    }).pipe(Effect.provide(buildLayer(home, path.join(home, "fakebin", "pi")))),
  );
});
