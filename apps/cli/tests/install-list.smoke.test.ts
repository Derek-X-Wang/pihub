import { it } from "@effect/vitest";
import { BunContext } from "@effect/platform-bun";
import {
  GitClient,
  GithubApi,
  Installer,
  LockfileStore,
  ManifestParser,
  NpmRegistry,
  Paths,
  Profile,
  RegistryStore,
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

const buildLiveLayer = (homeDir: string) => {
  const Base = Layer.mergeAll(
    Paths.Test(homeDir),
    BunContext.layer,
    GithubApi.Test(),
    GitClient.Test(),
    NpmRegistry.Test(),
    TarExtractor.Test(),
  );
  const Leaves = Layer.mergeAll(
    ShapeDetector.Live,
    ManifestParser.Live,
    SourceFetcher.Live,
    Profile.Live,
    LockfileStore.Live,
    RegistryStore.Live,
  ).pipe(Layer.provideMerge(Base));
  return Installer.Live.pipe(Layer.provideMerge(Leaves));
};

describe("install + list (live, fixture-driven smoke)", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-smoke-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("install copies repo, writes lockfile + profile + 2 registry entries", () =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const result = yield* installer.install(FIXTURE);
      expect(result.cached).toBe(false);
      expect(result.agentRoot).toBe("sample-beta-agent");

      // Repo copied (acceptance criterion #2)
      const repoMd = path.join(home, "agents", "sample-beta-agent", "repo", "agents", "scout.md");
      const repoExists = yield* Effect.promise(() =>
        fsp
          .access(repoMd)
          .then(() => true)
          .catch(() => false),
      );
      expect(repoExists).toBe(true);

      // Lockfile written (acceptance criterion #3)
      const lockPath = path.join(home, "agents", "sample-beta-agent", "install.lock.json");
      const lockExists = yield* Effect.promise(() =>
        fsp
          .access(lockPath)
          .then(() => true)
          .catch(() => false),
      );
      expect(lockExists).toBe(true);
      const lockJson = JSON.parse(yield* Effect.promise(() => fsp.readFile(lockPath, "utf8")));
      expect(typeof lockJson.commitSha).toBe("string");
      expect(lockJson.commitSha.length).toBeGreaterThan(0);
      expect(lockJson.piSlot).toBe("default");
      expect(lockJson.installedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Profile dir created (acceptance criterion #4)
      const profilePath = path.join(home, "agents", "sample-beta-agent", "profile");
      const profileExists = yield* Effect.promise(() =>
        fsp
          .stat(profilePath)
          .then((s) => s.isDirectory())
          .catch(() => false),
      );
      expect(profileExists).toBe(true);

      // Registry contains 2 entries with sub-agent canonical names (acceptance criterion #5)
      const registry = yield* RegistryStore;
      const reg = yield* registry.read;
      expect(reg.agents.map((a) => a.name).sort()).toEqual([
        "sample-beta-agent:planner",
        "sample-beta-agent:scout",
      ]);
      const scout = reg.agents.find((a) => a.name === "sample-beta-agent:scout");
      expect(scout?.shape).toBe("beta");
      expect(scout?.description).toBe(
        "Fast codebase recon that returns compressed context for handoff to other agents",
      );
    }).pipe(Effect.provide(buildLiveLayer(home))),
  );

  it.effect("re-install of the same fixture is idempotent (acceptance criterion #7)", () =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const registry = yield* RegistryStore;
      const lockStore = yield* LockfileStore;

      const first = yield* installer.install(FIXTURE);
      const lockBefore = yield* lockStore.read("sample-beta-agent");

      const second = yield* installer.install(FIXTURE);
      const lockAfter = yield* lockStore.read("sample-beta-agent");
      const reg2 = yield* registry.read;

      expect(second.cached).toBe(true);
      expect(reg2.agents).toHaveLength(2);
      // Lockfile content unchanged across re-install (matching commitSha case skips write).
      expect(JSON.stringify(lockBefore)).toBe(JSON.stringify(lockAfter));
      expect(first.entries.length).toBe(second.entries.length);
    }).pipe(Effect.provide(buildLiveLayer(home))),
  );
});
