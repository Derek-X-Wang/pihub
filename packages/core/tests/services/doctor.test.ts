import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Lockfile, RegistryEntry } from "@pihub/schema";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Paths } from "../../src/paths.js";
import { AliasStore } from "../../src/services/alias-store.js";
import { Doctor } from "../../src/services/doctor.js";
import { LockfileStore } from "../../src/services/lockfile-store.js";
import { RegistryStore } from "../../src/services/registry-store.js";

const sampleEntry = (name: string, piSlot = "0.74"): RegistryEntry => ({
  name,
  shape: "alpha",
  piSlot,
  source: "/abs/agent",
  ref: "tree-abc",
  commitSha: "abc",
  description: "",
  invoke: `pihub invoke ${name} "<task>"`,
  envDeclared: [],
  linked: false,
  permissions: [],
});

const sampleLock = (link = false, source = "/abs/agent"): Lockfile => ({
  source,
  ref: "tree-abc",
  commitSha: "abc",
  piSlot: "0.74",
  depsLockSha: "",
  installedAt: "2026-05-09T00:00:00.000Z",
  link,
});

const buildLayer = (
  homeDir: string,
  entries: ReadonlyArray<RegistryEntry>,
  locks: Map<string, Lockfile> = new Map(),
  aliases: ReadonlyMap<string, string> = new Map(),
) =>
  Doctor.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Paths.Test(homeDir),
        BunContext.layer,
        RegistryStore.Test(entries),
        LockfileStore.Test(locks),
        AliasStore.Test(aliases),
      ),
    ),
  );

const seedHealthy = async (home: string) => {
  // Pre-create the agent root, profile, repo, lockfile.
  const agentRoot = path.join(home, "agents", "owner/repo");
  await fsp.mkdir(path.join(agentRoot, "profile"), { recursive: true });
  await fsp.mkdir(path.join(agentRoot, "repo"), { recursive: true });
  await fsp.writeFile(path.join(agentRoot, "install.lock.json"), "{}");
  // Pi runtime slot.
  const slotBin = path.join(home, "runtime", "pi", "0.74", "node_modules", ".bin");
  await fsp.mkdir(slotBin, { recursive: true });
  await fsp.writeFile(path.join(slotBin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // Logs dir.
  await fsp.mkdir(path.join(home, "logs"), { recursive: true });
  // Global env file with mode 0600.
  await fsp.writeFile(path.join(home, "env"), "FOO=bar\n", { mode: 0o600 });
};

describe("Doctor", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-doctor-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("healthy install: ok=true, all checks pass or warn", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedHealthy(home));
      const doctor = yield* Doctor;
      const report = yield* doctor.run;
      expect(report.ok).toBe(true);
      const failed = report.checks.filter((c) => c.status === "fail");
      expect(failed).toEqual([]);
    }).pipe(
      Effect.provide(
        buildLayer(home, [sampleEntry("owner/repo")], new Map([["owner/repo", sampleLock()]])),
      ),
    ),
  );

  it.effect("missing runtime slot: runtime-slots check fails", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedHealthy(home));
      // Remove the slot dir while a registered agent still pins it.
      yield* Effect.promise(() =>
        fsp.rm(path.join(home, "runtime", "pi", "0.74"), { recursive: true, force: true }),
      );
      const doctor = yield* Doctor;
      const report = yield* doctor.run;
      const slot = report.checks.find((c) => c.name === "runtime-slots");
      expect(slot?.status).toBe("fail");
      expect(report.ok).toBe(false);
    }).pipe(
      Effect.provide(
        buildLayer(home, [sampleEntry("owner/repo")], new Map([["owner/repo", sampleLock()]])),
      ),
    ),
  );

  it.effect("env file mode 0644: env-file-modes check fails", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedHealthy(home));
      yield* Effect.promise(() => fsp.chmod(path.join(home, "env"), 0o644));
      const doctor = yield* Doctor;
      const report = yield* doctor.run;
      const envCheck = report.checks.find((c) => c.name === "env-file-modes");
      expect(envCheck?.status).toBe("fail");
      expect(envCheck?.details).toContain("644");
      expect(report.ok).toBe(false);
    }).pipe(
      Effect.provide(
        buildLayer(home, [sampleEntry("owner/repo")], new Map([["owner/repo", sampleLock()]])),
      ),
    ),
  );

  it.effect("missing agent dir: agent-profiles check fails", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedHealthy(home));
      yield* Effect.promise(() =>
        fsp.rm(path.join(home, "agents", "owner/repo"), { recursive: true, force: true }),
      );
      const doctor = yield* Doctor;
      const report = yield* doctor.run;
      const profiles = report.checks.find((c) => c.name === "agent-profiles");
      expect(profiles?.status).toBe("fail");
      expect(report.ok).toBe(false);
    }).pipe(
      Effect.provide(
        buildLayer(home, [sampleEntry("owner/repo")], new Map([["owner/repo", sampleLock()]])),
      ),
    ),
  );

  it.effect("dangling alias: aliases check fails", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => seedHealthy(home));
      const doctor = yield* Doctor;
      const report = yield* doctor.run;
      const aliasCheck = report.checks.find((c) => c.name === "aliases");
      expect(aliasCheck?.status).toBe("fail");
      expect(aliasCheck?.details).toContain("ghost");
      expect(report.ok).toBe(false);
    }).pipe(
      Effect.provide(
        buildLayer(
          home,
          [sampleEntry("owner/repo")],
          new Map([["owner/repo", sampleLock()]]),
          new Map([["ghost", "does-not-exist"]]),
        ),
      ),
    ),
  );
});
