import { Manifest, RegistryEntry } from "@pihub/schema";
import { Context, Effect, Layer, Option } from "effect";
import * as path from "node:path";
import {
  CopyError,
  FrontmatterParseError,
  InvalidShapeError,
  LockfileError,
  ManifestParseError,
  ProfileError,
  RegistryError,
  SourceNotFoundError,
} from "../errors.js";
import { Paths } from "../paths.js";
import type { BetaAgentInfo, SourceInfo } from "../types.js";
import { LockfileStore } from "./lockfile-store.js";
import { ManifestParser } from "./manifest-parser.js";
import { Profile } from "./profile.js";
import { RegistryStore } from "./registry-store.js";
import { ShapeDetector } from "./shape-detector.js";
import { SourceFetcher } from "./source-fetcher.js";

export type InstallerError =
  | SourceNotFoundError
  | InvalidShapeError
  | ManifestParseError
  | FrontmatterParseError
  | CopyError
  | ProfileError
  | LockfileError
  | RegistryError;

export interface InstallResult {
  readonly agentRoot: string;
  readonly entries: ReadonlyArray<RegistryEntry>;
  readonly cached: boolean;
}

export interface InstallerShape {
  readonly install: (source: string) => Effect.Effect<InstallResult, InstallerError>;
}

/**
 * Derive the canonical agent-root name from a source URL or local path. For
 * local paths this is the basename of the absolute resolved path. Slice #4+
 * adds `<owner>/<repo>` derivation for github URLs.
 */
const computeAgentRoot = (source: string): string => {
  const resolved = path.isAbsolute(source) ? source : path.resolve(source);
  return path.basename(resolved.replace(/\/+$/, ""));
};

const buildBetaEntry = (
  agentRoot: string,
  agent: BetaAgentInfo,
  info: SourceInfo,
  manifest: Manifest,
  piSlot: string,
): RegistryEntry => {
  const name = `${agentRoot}:${agent.subName}`;
  return {
    name,
    shape: "beta",
    piSlot,
    source: info.source,
    ref: info.ref,
    commitSha: info.commitSha,
    description: agent.description || manifest.description || "",
    invoke: `pihub invoke ${name} "<task>"`,
    envDeclared: manifest.env ? [...manifest.env] : [],
  };
};

/**
 * Default Pi runtime slot label until slice #8 introduces the
 * RuntimeSlotManager. Tracked under `~/.pihub/runtime/pi/default/`.
 */
const DEFAULT_PI_SLOT = "default";

export class Installer extends Context.Tag("Installer")<Installer, InstallerShape>() {
  static readonly Live = Layer.effect(
    Installer,
    Effect.gen(function* () {
      const fetcher = yield* SourceFetcher;
      const detector = yield* ShapeDetector;
      const manifestParser = yield* ManifestParser;
      const profile = yield* Profile;
      const lockStore = yield* LockfileStore;
      const registry = yield* RegistryStore;
      const paths = yield* Paths;

      return Installer.of({
        install: (source) =>
          Effect.gen(function* () {
            const agentRoot = computeAgentRoot(source);
            const repoPath = paths.agentRepo(agentRoot);

            const info = yield* fetcher.fetch(source, repoPath);
            const detection = yield* detector.detect(repoPath);
            if (detection.kind !== "beta") {
              return yield* Effect.fail(
                new InvalidShapeError({
                  source,
                  message: `slice #3 supports only shape β; detected ${detection.kind}`,
                }),
              );
            }
            const manifest = yield* manifestParser.parse(repoPath);
            yield* profile.ensure(agentRoot);

            const entries = detection.agents.map((agent) =>
              buildBetaEntry(agentRoot, agent, info, manifest, DEFAULT_PI_SLOT),
            );

            const existingLock = yield* lockStore.read(agentRoot);
            const cached = Option.match(existingLock, {
              onNone: () => false,
              onSome: (lock) =>
                lock.source === info.source &&
                lock.commitSha === info.commitSha &&
                lock.depsLockSha === info.depsLockSha,
            });

            if (cached) {
              const reg = yield* registry.read;
              const existing = reg.agents.filter(
                (a) => a.name === agentRoot || a.name.startsWith(`${agentRoot}:`),
              );
              if (existing.length > 0) {
                return { agentRoot, entries: existing, cached: true } satisfies InstallResult;
              }
              // Lockfile says cached but registry empty — repair by upserting.
            }

            yield* lockStore.write(agentRoot, {
              source: info.source,
              ref: info.ref,
              commitSha: info.commitSha,
              piSlot: DEFAULT_PI_SLOT,
              depsLockSha: info.depsLockSha,
              installedAt: new Date().toISOString(),
            });
            yield* registry.upsertAgents(entries);

            return { agentRoot, entries, cached: false } satisfies InstallResult;
          }),
      });
    }),
  );
}
