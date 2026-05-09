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
