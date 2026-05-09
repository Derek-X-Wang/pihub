import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import { Paths } from "../../src/paths.js";
import { Installer } from "../../src/services/installer.js";
import { LockfileStore } from "../../src/services/lockfile-store.js";
import { ManifestParser } from "../../src/services/manifest-parser.js";
import { Profile } from "../../src/services/profile.js";
import { RegistryStore } from "../../src/services/registry-store.js";
import { ShapeDetector } from "../../src/services/shape-detector.js";
import { SourceFetcher } from "../../src/services/source-fetcher.js";
import type { DetectionResult } from "../../src/types.js";

const FIXTURE_PATH = "/abs/sample-beta-agent";
const TEST_HOME = "/tmp/.pihub-installer-test";

const detection: DetectionResult = {
  kind: "beta",
  agents: [
    { subName: "scout", description: "fast codebase recon", mdPath: "agents/scout.md" },
    { subName: "planner", description: "writes plans", mdPath: "agents/planner.md" },
  ],
};

const buildAppLayer = () => {
  const pathsLayer = Paths.Test(TEST_HOME);
  // Repo path the Installer hands to ShapeDetector — Paths.Test computes it.
  const repoPath = `${TEST_HOME}/agents/sample-beta-agent/repo`;
  const fakes = Layer.mergeAll(
    pathsLayer,
    SourceFetcher.Test(),
    ShapeDetector.Test(new Map([[repoPath, detection]])),
    ManifestParser.Test(),
    Profile.Test(),
    LockfileStore.Test(),
    RegistryStore.Test(),
  );
  return Installer.Live.pipe(Layer.provideMerge(fakes));
};

describe("Installer (happy path with fakes)", () => {
  it.effect("installs a shape-β agent and writes registry + lockfile", () =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const result = yield* installer.install(FIXTURE_PATH);
      expect(result.cached).toBe(false);
      expect(result.agentRoot).toBe("sample-beta-agent");
      expect(result.entries).toHaveLength(2);

      const names = result.entries.map((e) => e.name).sort();
      expect(names).toEqual(["sample-beta-agent:planner", "sample-beta-agent:scout"]);

      const registry = yield* RegistryStore;
      const reg = yield* registry.read;
      expect(reg.agents.map((a) => a.name).sort()).toEqual(names);

      const scout = reg.agents.find((a) => a.name === "sample-beta-agent:scout");
      expect(scout?.shape).toBe("beta");
      expect(scout?.invoke).toBe('pihub invoke sample-beta-agent:scout "<task>"');
      expect(scout?.description).toBe("fast codebase recon");
      expect(scout?.piSlot).toBe("default");

      const lockStore = yield* LockfileStore;
      const lock = yield* lockStore.read("sample-beta-agent");
      expect(lock._tag).toBe("Some");
    }).pipe(Effect.provide(buildAppLayer())),
  );

  it.effect("re-install of an unchanged source is idempotent — registry unchanged", () =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const registry = yield* RegistryStore;

      const first = yield* installer.install(FIXTURE_PATH);
      expect(first.cached).toBe(false);
      const after1 = yield* registry.read;
      const sorted1 = [...after1.agents].map((a) => a.name).sort();

      const second = yield* installer.install(FIXTURE_PATH);
      expect(second.cached).toBe(true);
      expect(second.entries.map((e) => e.name).sort()).toEqual(sorted1);

      const after2 = yield* registry.read;
      expect(after2.agents.map((a) => a.name).sort()).toEqual(sorted1);
      expect(first.entries.length).toBe(second.entries.length);
    }).pipe(Effect.provide(buildAppLayer())),
  );
});

describe("Installer (--frozen flag)", () => {
  it.effect("--frozen against a missing lockfile fails with FrozenDriftError", () =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const exit = yield* Effect.exit(installer.install(FIXTURE_PATH, { frozen: true }));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("FrozenDriftError");
    }).pipe(Effect.provide(buildAppLayer())),
  );

  it.effect("--frozen against a matching lockfile succeeds without writes", () =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const registry = yield* RegistryStore;

      // Establish baseline
      const first = yield* installer.install(FIXTURE_PATH);
      expect(first.cached).toBe(false);
      const before = yield* registry.read;

      // Frozen verification — same source, same SourceFetcher canned info
      const verified = yield* installer.install(FIXTURE_PATH, { frozen: true });
      expect(verified.cached).toBe(true);

      const after = yield* registry.read;
      expect(after.agents.map((a) => a.name).sort()).toEqual(
        before.agents.map((a) => a.name).sort(),
      );
    }).pipe(Effect.provide(buildAppLayer())),
  );

  it.effect("--frozen with drift fails with FrozenDriftError", () =>
    Effect.gen(function* () {
      const driftLayer = (() => {
        const repoPath = `${TEST_HOME}/agents/sample-beta-agent/repo`;
        const fakes = Layer.mergeAll(
          Paths.Test(TEST_HOME),
          // First fetch returns one SHA, then mutate fetcher seed via re-build
          // We simulate drift by seeding the SourceFetcher with two distinct
          // SourceInfo records keyed by the same source — that's not directly
          // expressible, so emulate drift by writing the lockfile directly via
          // the LockfileStore.Test seed and skipping the first install.
          SourceFetcher.Test(),
          ShapeDetector.Test(new Map([[repoPath, detection]])),
          ManifestParser.Test(),
          Profile.Test(),
          LockfileStore.Test(
            new Map([
              [
                "sample-beta-agent",
                {
                  source: FIXTURE_PATH,
                  ref: "tree-old",
                  commitSha: "old-commit-sha",
                  piSlot: "default",
                  depsLockSha: "",
                  installedAt: "2026-05-09T00:00:00.000Z",
                  link: false,
                },
              ],
            ]),
          ),
          RegistryStore.Test(),
        );
        return Installer.Live.pipe(Layer.provideMerge(fakes));
      })();

      const exit = yield* Effect.gen(function* () {
        const installer = yield* Installer;
        return yield* Effect.exit(installer.install(FIXTURE_PATH, { frozen: true }));
      }).pipe(Effect.provide(driftLayer));

      expect(exit._tag).toBe("Failure");
      const flat = JSON.stringify(exit);
      expect(flat).toContain("FrozenDriftError");
      expect(flat).toContain("old-commit-sha");
    }),
  );
});

describe("Installer (--link flag)", () => {
  it.effect("--link forwards link=true to SourceFetcher and marks entries linked", () =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const registry = yield* RegistryStore;
      const lockStore = yield* LockfileStore;

      const result = yield* installer.install(FIXTURE_PATH, { link: true });
      expect(result.cached).toBe(false);
      expect(result.entries.every((e) => e.linked)).toBe(true);

      const reg = yield* registry.read;
      expect(reg.agents.every((a) => a.linked)).toBe(true);

      const lock = yield* lockStore.read("sample-beta-agent");
      expect(lock._tag).toBe("Some");
      if (lock._tag === "Some") {
        expect(lock.value.link).toBe(true);
        expect(lock.value.depsLockSha).toBe("");
        expect(lock.value.commitSha).toContain("link:");
      }
    }).pipe(Effect.provide(buildAppLayer())),
  );

  it.effect("--link rejected when source is not local (npm)", () =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const exit = yield* Effect.exit(installer.install("npm:tiny-package@1.0.0", { link: true }));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("LinkSourceUnsupportedError");
    }).pipe(Effect.provide(buildAppLayer())),
  );

  it.effect("--link rejected when source is github", () =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const exit = yield* Effect.exit(
        installer.install("github:owner/repo@v0.1.0", { link: true }),
      );
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("LinkSourceUnsupportedError");
    }).pipe(Effect.provide(buildAppLayer())),
  );
});
