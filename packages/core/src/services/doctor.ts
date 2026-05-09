import { FileSystem } from "@effect/platform";
import { DoctorCheck, DoctorReport } from "@pihub/schema";
import { Context, Effect, Layer } from "effect";
import * as path from "node:path";
import { Paths } from "../paths.js";
import { AliasStore } from "./alias-store.js";
import { LockfileStore } from "./lockfile-store.js";
import { RegistryStore } from "./registry-store.js";

export interface DoctorShape {
  readonly run: Effect.Effect<DoctorReport, never>;
}

const ENV_MODE = 0o600;

const checkRegistry = (registry: typeof RegistryStore.Service): Effect.Effect<DoctorCheck, never> =>
  registry.read.pipe(
    Effect.match({
      onFailure: (e) => ({
        name: "registry",
        status: "fail" as const,
        message: "registry.json failed to load",
        details: e.message,
      }),
      onSuccess: (reg) => ({
        name: "registry",
        status: "pass" as const,
        message: `${reg.agents.length} agent(s) registered`,
      }),
    }),
  );

const checkRuntimeSlots = (
  fs: FileSystem.FileSystem,
  registry: typeof RegistryStore.Service,
  paths: typeof Paths.Service,
): Effect.Effect<DoctorCheck, never> =>
  Effect.gen(function* () {
    const reg = yield* registry.read.pipe(
      Effect.catchAll(() =>
        Effect.succeed({ version: 1, agents: [] as ReadonlyArray<{ piSlot: string }> }),
      ),
    );
    const minors = Array.from(new Set(reg.agents.map((a) => a.piSlot)));
    const missing: string[] = [];
    for (const minor of minors) {
      const binPath = path.join(paths.runtimeSlot(minor), "node_modules", ".bin", "pi");
      const exists = yield* fs.exists(binPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) missing.push(minor);
    }
    if (missing.length > 0) {
      return {
        name: "runtime-slots",
        status: "fail" as const,
        message: `${missing.length} pinned slot(s) missing pi binary`,
        details: `missing: ${missing.join(", ")} — run \`pihub runtime install <minor>\``,
      };
    }
    return {
      name: "runtime-slots",
      status: "pass" as const,
      message: `${minors.length} slot(s) populated`,
    };
  });

const checkAgentProfiles = (
  fs: FileSystem.FileSystem,
  registry: typeof RegistryStore.Service,
  paths: typeof Paths.Service,
  lockfileStore: typeof LockfileStore.Service,
): Effect.Effect<DoctorCheck, never> =>
  Effect.gen(function* () {
    const reg = yield* registry.read.pipe(
      Effect.catchAll(() =>
        Effect.succeed({ version: 1, agents: [] as ReadonlyArray<{ name: string }> }),
      ),
    );
    // Group by agent root (β β agents share a root).
    const roots = Array.from(
      new Set(
        reg.agents.map((a) => {
          const colon = a.name.indexOf(":");
          return colon === -1 ? a.name : a.name.slice(0, colon);
        }),
      ),
    );
    const broken: string[] = [];
    for (const root of roots) {
      const agentRoot = paths.agentRoot(root);
      const repo = paths.agentRepo(root);
      const profile = paths.agentProfile(root);
      const lockPath = paths.agentLockfile(root);
      const dirOk = yield* fs.exists(agentRoot).pipe(Effect.orElseSucceed(() => false));
      const repoOk = yield* fs.exists(repo).pipe(Effect.orElseSucceed(() => false));
      const profileOk = yield* fs.exists(profile).pipe(Effect.orElseSucceed(() => false));
      const lockOk = yield* fs.exists(lockPath).pipe(Effect.orElseSucceed(() => false));
      if (!dirOk || !repoOk || !profileOk || !lockOk) {
        broken.push(root);
        continue;
      }
      const lockReadResult = yield* lockfileStore.read(root).pipe(Effect.either);
      if (lockReadResult._tag === "Left" || lockReadResult.right._tag !== "Some") {
        broken.push(`${root} (lockfile parse failed)`);
        continue;
      }
      const lockData = lockReadResult.right.value;
      // Linked agents: verify the link target still exists on disk.
      if (lockData.link) {
        const targetOk = yield* fs.exists(lockData.source).pipe(Effect.orElseSucceed(() => false));
        if (!targetOk) broken.push(`${root} (linked target missing: ${lockData.source})`);
      }
    }
    if (broken.length > 0) {
      return {
        name: "agent-profiles",
        status: "fail" as const,
        message: `${broken.length} agent(s) corrupt or partially installed`,
        details: broken.join("; "),
      };
    }
    return {
      name: "agent-profiles",
      status: "pass" as const,
      message: `${roots.length} agent root(s) clean`,
    };
  });

const checkEnvFiles = (
  fs: FileSystem.FileSystem,
  paths: typeof Paths.Service,
  registry: typeof RegistryStore.Service,
): Effect.Effect<DoctorCheck, never> =>
  Effect.gen(function* () {
    const targets: string[] = [paths.globalEnv];
    const reg = yield* registry.read.pipe(
      Effect.catchAll(() =>
        Effect.succeed({ version: 1, agents: [] as ReadonlyArray<{ name: string }> }),
      ),
    );
    const roots = Array.from(
      new Set(
        reg.agents.map((a) => {
          const colon = a.name.indexOf(":");
          return colon === -1 ? a.name : a.name.slice(0, colon);
        }),
      ),
    );
    for (const r of roots) targets.push(paths.agentEnv(r));

    const wrongMode: string[] = [];
    for (const target of targets) {
      const exists = yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      const stat = yield* fs.stat(target).pipe(Effect.option);
      if (stat._tag !== "Some") continue;
      // FileSystem stat returns mode as bigint; mask the file-permission bits.
      const mode = Number(stat.value.mode) & 0o777;
      if (mode !== ENV_MODE) {
        wrongMode.push(`${target} (mode ${mode.toString(8).padStart(3, "0")})`);
      }
    }
    if (wrongMode.length > 0) {
      return {
        name: "env-file-modes",
        status: "fail" as const,
        message: `${wrongMode.length} env file(s) not mode 0600`,
        details: wrongMode.join("; "),
      };
    }
    return {
      name: "env-file-modes",
      status: "pass" as const,
      message: "all env files mode 0600",
    };
  });

const checkAliases = (
  registry: typeof RegistryStore.Service,
  aliasStore: typeof AliasStore.Service,
): Effect.Effect<DoctorCheck, never> =>
  Effect.gen(function* () {
    const aliases = yield* aliasStore.read.pipe(
      Effect.catchAll(() => Effect.succeed({ version: 1, map: {} as Record<string, string> })),
    );
    const reg = yield* registry.read.pipe(
      Effect.catchAll(() =>
        Effect.succeed({ version: 1, agents: [] as ReadonlyArray<{ name: string }> }),
      ),
    );
    const names = new Set(reg.agents.map((a) => a.name));
    const dangling: string[] = [];
    for (const [short, canonical] of Object.entries(aliases.map)) {
      if (!names.has(canonical)) dangling.push(`${short} → ${canonical}`);
    }
    if (dangling.length > 0) {
      return {
        name: "aliases",
        status: "fail" as const,
        message: `${dangling.length} alias(es) point at unknown agents`,
        details: dangling.join("; "),
      };
    }
    return {
      name: "aliases",
      status: "pass" as const,
      message: `${Object.keys(aliases.map).length} alias(es) all resolve`,
    };
  });

const checkLogsDir = (
  fs: FileSystem.FileSystem,
  paths: typeof Paths.Service,
): Effect.Effect<DoctorCheck, never> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(paths.logsRoot).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return {
        name: "logs-dir",
        status: "warn" as const,
        message: "logs directory does not exist (no invocations yet?)",
      };
    }
    return {
      name: "logs-dir",
      status: "pass" as const,
      message: "logs directory present",
    };
  });

const checkPath = (paths: typeof Paths.Service): Effect.Effect<DoctorCheck, never> =>
  Effect.sync(() => {
    // Naive PATH check: pihub binary expected at ~/.local/bin per install.sh.
    const expected = path.join(path.dirname(paths.home), ".local", "bin");
    const segments = (process.env["PATH"] ?? "").split(":");
    if (segments.includes(expected)) {
      return {
        name: "path",
        status: "pass" as const,
        message: `${expected} on PATH`,
      };
    }
    return {
      name: "path",
      status: "warn" as const,
      message: `${expected} not on PATH`,
      details: `add it to your shell init: export PATH="${expected}:$PATH"`,
    };
  });

export class Doctor extends Context.Tag("Doctor")<Doctor, DoctorShape>() {
  static readonly Live = Layer.effect(
    Doctor,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      const registry = yield* RegistryStore;
      const aliasStore = yield* AliasStore;
      const lockfileStore = yield* LockfileStore;
      return {
        run: Effect.gen(function* () {
          const checks: DoctorCheck[] = [];
          checks.push(yield* checkRegistry(registry));
          checks.push(yield* checkRuntimeSlots(fs, registry, paths));
          checks.push(yield* checkAgentProfiles(fs, registry, paths, lockfileStore));
          checks.push(yield* checkEnvFiles(fs, paths, registry));
          checks.push(yield* checkAliases(registry, aliasStore));
          checks.push(yield* checkLogsDir(fs, paths));
          checks.push(yield* checkPath(paths));
          const ok = checks.every((c) => c.status !== "fail");
          return { ok, checks };
        }),
      } satisfies DoctorShape;
    }),
  );
}
