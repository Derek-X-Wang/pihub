import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Lockfile, RegistryEntry } from "@pihub/schema";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Paths } from "../../src/paths.js";
import { LockfileStore } from "../../src/services/lockfile-store.js";
import { ManifestParser } from "../../src/services/manifest-parser.js";
import { PiInstaller } from "../../src/services/pi-installer.js";
import { RegistryStore } from "../../src/services/registry-store.js";
import { RuntimeSlotManager } from "../../src/services/runtime-slot.js";
import { ShapeDetector } from "../../src/services/shape-detector.js";
import { SourceFetcher } from "../../src/services/source-fetcher.js";
import { Updater } from "../../src/services/updater.js";
import type { DetectionResult, SourceInfo } from "../../src/types.js";

const sampleEntry = (name: string, piSlot = "0.74", source = "/abs/agent"): RegistryEntry => ({
  name,
  shape: "alpha",
  piSlot,
  source,
  ref: "tree-old",
  commitSha: "old-sha",
  description: "",
  invoke: `pihub invoke ${name} "<task>"`,
  envDeclared: [],
  linked: false,
  permissions: [],
});

const sampleLock = (
  source = "/abs/agent",
  commitSha = "old-sha",
  piSlot = "0.74",
  link = false,
): Lockfile => ({
  source,
  ref: "tree-old",
  commitSha,
  piSlot,
  depsLockSha: "",
  installedAt: "2026-05-09T00:00:00.000Z",
  link,
});

const detectionAlpha = (): DetectionResult => ({
  kind: "alpha",
  info: { packageName: "owner/repo", description: "agent", piRange: "^0.74.0" },
});

const buildLayer = (
  homeDir: string,
  entries: ReadonlyArray<RegistryEntry>,
  locks: Map<string, Lockfile>,
  fetchSeed: ReadonlyMap<string, SourceInfo>,
  detection: DetectionResult = detectionAlpha(),
) => {
  const Base = Layer.mergeAll(
    Paths.Test(homeDir),
    BunContext.layer,
    SourceFetcher.Test(fetchSeed),
    // `*` wildcard handles both the real repo path and the random tempdir
    // path used during --dry-run.
    ShapeDetector.Test(new Map([["*", detection]])),
    ManifestParser.Test(),
    LockfileStore.Test(locks),
    RegistryStore.Test(entries),
    RuntimeSlotManager.Test(new Map([["*", "/fake/pi"]])),
    PiInstaller.Test(),
  );
  return Updater.Live.pipe(Layer.provideMerge(Base));
};

describe("Updater", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-update-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("no-op when commitSha and depsLockSha match", () =>
    Effect.gen(function* () {
      const updater = yield* Updater;
      const result = yield* updater.update("owner/repo");
      expect(result.kind).toBe("no-change");
      expect(result.oldCommitSha).toBe("old-sha");
      expect(result.newCommitSha).toBe("old-sha");
    }).pipe(
      Effect.provide(
        buildLayer(
          home,
          [sampleEntry("owner/repo")],
          new Map([["owner/repo", sampleLock()]]),
          new Map([
            [
              "/abs/agent",
              {
                source: "/abs/agent",
                ref: "tree-old",
                commitSha: "old-sha",
                depsLockSha: "",
                link: false,
              } satisfies SourceInfo,
            ],
          ]),
        ),
      ),
    ),
  );

  it.effect("applies when commitSha differs", () =>
    Effect.gen(function* () {
      const updater = yield* Updater;
      const result = yield* updater.update("owner/repo");
      expect(result.kind).toBe("applied");
      expect(result.newCommitSha).toBe("new-sha");

      // Lockfile bumped to new sha.
      const lockStore = yield* LockfileStore;
      const lock = yield* lockStore.read("owner/repo");
      if (lock._tag === "Some") {
        expect(lock.value.commitSha).toBe("new-sha");
      }
    }).pipe(
      Effect.provide(
        buildLayer(
          home,
          [sampleEntry("owner/repo")],
          new Map([["owner/repo", sampleLock()]]),
          new Map([
            [
              "/abs/agent",
              {
                source: "/abs/agent",
                ref: "tree-new",
                commitSha: "new-sha",
                depsLockSha: "",
                link: false,
              } satisfies SourceInfo,
            ],
          ]),
        ),
      ),
    ),
  );

  it.effect("--dry-run reports diff but doesn't write the lockfile", () =>
    Effect.gen(function* () {
      const updater = yield* Updater;
      const result = yield* updater.update("owner/repo", { dryRun: true });
      expect(result.kind).toBe("dry-run-would-apply");
      expect(result.newCommitSha).toBe("new-sha");

      const lockStore = yield* LockfileStore;
      const lock = yield* lockStore.read("owner/repo");
      if (lock._tag === "Some") {
        // Lockfile unchanged on dry-run.
        expect(lock.value.commitSha).toBe("old-sha");
      }
    }).pipe(
      Effect.provide(
        buildLayer(
          home,
          [sampleEntry("owner/repo")],
          new Map([["owner/repo", sampleLock()]]),
          new Map([
            [
              "/abs/agent",
              {
                source: "/abs/agent",
                ref: "tree-new",
                commitSha: "new-sha",
                depsLockSha: "",
                link: false,
              } satisfies SourceInfo,
            ],
          ]),
        ),
      ),
    ),
  );

  it.effect("--frozen with drift fails with FrozenDriftError", () =>
    Effect.gen(function* () {
      const updater = yield* Updater;
      const exit = yield* Effect.exit(updater.update("owner/repo", { frozen: true }));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("FrozenDriftError");
    }).pipe(
      Effect.provide(
        buildLayer(
          home,
          [sampleEntry("owner/repo")],
          new Map([["owner/repo", sampleLock()]]),
          new Map([
            [
              "/abs/agent",
              {
                source: "/abs/agent",
                ref: "tree-new",
                commitSha: "new-sha",
                depsLockSha: "",
                link: false,
              } satisfies SourceInfo,
            ],
          ]),
        ),
      ),
    ),
  );

  it.effect("linked agents are no-ops", () =>
    Effect.gen(function* () {
      const updater = yield* Updater;
      const result = yield* updater.update("owner/repo");
      expect(result.kind).toBe("linked-skipped");
    }).pipe(
      Effect.provide(
        buildLayer(
          home,
          [sampleEntry("owner/repo")],
          new Map([["owner/repo", sampleLock("/abs/agent", "link:/abs/agent", "0.74", true)]]),
          new Map(),
        ),
      ),
    ),
  );

  it.effect("shape change is rejected", () =>
    Effect.gen(function* () {
      const updater = yield* Updater;
      const exit = yield* Effect.exit(updater.update("owner/repo"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("InvalidShapeError");
      expect(JSON.stringify(exit)).toContain("shape changed from alpha to beta");
    }).pipe(
      Effect.provide(
        buildLayer(
          home,
          [sampleEntry("owner/repo")],
          new Map([["owner/repo", sampleLock()]]),
          new Map([
            [
              "/abs/agent",
              {
                source: "/abs/agent",
                ref: "tree-new",
                commitSha: "new-sha",
                depsLockSha: "",
                link: false,
              } satisfies SourceInfo,
            ],
          ]),
          {
            kind: "beta",
            agents: [{ subName: "scout", description: "", mdPath: "agents/scout.md" }],
          },
        ),
      ),
    ),
  );

  it.effect("missing lockfile → AgentNotFoundError", () =>
    Effect.gen(function* () {
      const updater = yield* Updater;
      const exit = yield* Effect.exit(updater.update("nope"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("AgentNotFoundError");
    }).pipe(Effect.provide(buildLayer(home, [], new Map(), new Map()))),
  );
});
