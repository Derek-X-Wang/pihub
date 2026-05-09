import { FileSystem } from "@effect/platform";
import { Manifest, RegistryEntry } from "@pihub/schema";
import { Context, Effect, Layer, Option } from "effect";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentNotFoundError,
  CopyError,
  FrontmatterParseError,
  FrozenDriftError,
  GitCloneError,
  GithubApiError,
  InvalidShapeError,
  LinkSourceUnsupportedError,
  LockfileError,
  ManifestParseError,
  NpmVersionNotFoundError,
  PiInstallError,
  RefNotFoundError,
  RegistryError,
  RuntimeSlotError,
  SourceFetchError,
  SourceNotFoundError,
} from "../errors.js";
import { extractPiMinor } from "../lib/parse-source.js";
import { Paths } from "../paths.js";
import type { AlphaAgentInfo, BetaAgentInfo, SourceInfo } from "../types.js";
import { LockfileStore } from "./lockfile-store.js";
import { ManifestParser } from "./manifest-parser.js";
import { PiInstaller } from "./pi-installer.js";
import { RegistryStore } from "./registry-store.js";
import { RuntimeSlotManager } from "./runtime-slot.js";
import { ShapeDetector } from "./shape-detector.js";
import { SourceFetcher } from "./source-fetcher.js";

const DEFAULT_PI_SLOT = "0.74";

export type UpdateKind = "linked-skipped" | "no-change" | "applied" | "dry-run-would-apply";

export interface UpdateResult {
  readonly agentRoot: string;
  readonly kind: UpdateKind;
  readonly oldCommitSha: string;
  readonly newCommitSha: string;
  readonly oldPiSlot: string;
  readonly newPiSlot: string;
  readonly source: string;
}

export type UpdaterError =
  | AgentNotFoundError
  | RegistryError
  | LockfileError
  | SourceNotFoundError
  | SourceFetchError
  | CopyError
  | GithubApiError
  | RefNotFoundError
  | GitCloneError
  | NpmVersionNotFoundError
  | InvalidShapeError
  | ManifestParseError
  | FrontmatterParseError
  | PiInstallError
  | FrozenDriftError
  | RuntimeSlotError
  | LinkSourceUnsupportedError;

export interface UpdateOptions {
  readonly dryRun?: boolean;
  readonly frozen?: boolean;
}

export interface UpdaterShape {
  readonly update: (
    agentRoot: string,
    opts?: UpdateOptions,
  ) => Effect.Effect<UpdateResult, UpdaterError>;
  readonly updateAll: (opts?: UpdateOptions) => Effect.Effect<
    ReadonlyArray<{
      readonly agentRoot: string;
      readonly result?: UpdateResult;
      readonly error?: string;
    }>,
    UpdaterError
  >;
}

const agentRootOf = (canonical: string): string => {
  const colon = canonical.indexOf(":");
  return colon === -1 ? canonical : canonical.slice(0, colon);
};

const buildBetaEntry = (
  agentRoot: string,
  agent: BetaAgentInfo,
  info: SourceInfo,
  manifest: Manifest,
  piSlot: string,
): RegistryEntry => {
  const name = `${agentRoot}:${agent.subName}`;
  const entry: RegistryEntry = {
    name,
    shape: "beta",
    piSlot,
    source: info.source,
    ref: info.ref,
    commitSha: info.commitSha,
    description: agent.description || manifest.description || "",
    invoke: `pihub invoke ${name} "<task>"`,
    envDeclared: manifest.env ? [...manifest.env] : [],
    linked: info.link,
    permissions: manifest.permissions ? [...manifest.permissions] : [],
  };
  if (manifest.timeoutSeconds !== undefined) {
    (entry as { timeoutSeconds: number }).timeoutSeconds = manifest.timeoutSeconds;
  }
  return entry;
};

const buildAlphaEntry = (
  agentRoot: string,
  alpha: AlphaAgentInfo,
  info: SourceInfo,
  manifest: Manifest,
  piSlot: string,
): RegistryEntry => {
  const entry: RegistryEntry = {
    name: agentRoot,
    shape: "alpha",
    piSlot,
    source: info.source,
    ref: info.ref,
    commitSha: info.commitSha,
    description: manifest.description || alpha.description || "",
    invoke: `pihub invoke ${agentRoot} "<task>"`,
    envDeclared: manifest.env ? [...manifest.env] : [],
    linked: info.link,
    permissions: manifest.permissions ? [...manifest.permissions] : [],
  };
  if (manifest.timeoutSeconds !== undefined) {
    (entry as { timeoutSeconds: number }).timeoutSeconds = manifest.timeoutSeconds;
  }
  return entry;
};

export class Updater extends Context.Tag("Updater")<Updater, UpdaterShape>() {
  static readonly Live = Layer.effect(
    Updater,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      const fetcher = yield* SourceFetcher;
      const detector = yield* ShapeDetector;
      const manifestParser = yield* ManifestParser;
      const lockStore = yield* LockfileStore;
      const registry = yield* RegistryStore;
      const runtime = yield* RuntimeSlotManager;
      const piInstaller = yield* PiInstaller;

      const updateOne = (
        rawAgent: string,
        opts?: UpdateOptions,
      ): Effect.Effect<UpdateResult, UpdaterError> =>
        Effect.gen(function* () {
          const root = agentRootOf(rawAgent);
          const profilePath = paths.agentProfile(root);
          const repoPath = paths.agentRepo(root);

          const lockOption = yield* lockStore.read(root);
          if (Option.isNone(lockOption)) {
            return yield* Effect.fail(
              new AgentNotFoundError({
                name: rawAgent,
                message: `no install lockfile for '${root}' — run \`pihub install <source>\` first`,
              }),
            );
          }
          const oldLock = lockOption.value;

          // --link agents have no lockfile to drift; skip silently.
          if (oldLock.link) {
            return {
              agentRoot: root,
              kind: "linked-skipped" as const,
              oldCommitSha: oldLock.commitSha,
              newCommitSha: oldLock.commitSha,
              oldPiSlot: oldLock.piSlot,
              newPiSlot: oldLock.piSlot,
              source: oldLock.source,
            };
          }

          // Re-resolve. For dry-run we fetch into a tempdir; for apply we
          // fetch directly into the real repo.
          const dryRun = opts?.dryRun === true;
          const targetRepo = dryRun
            ? path.join(os.tmpdir(), `pihub-update-${randomUUID()}`)
            : repoPath;
          const cleanup = Effect.promise(() =>
            import("node:fs/promises").then((m) =>
              m.rm(targetRepo, { recursive: true, force: true }),
            ),
          ).pipe(Effect.ignore);

          try {
            const info = yield* fetcher.fetch(oldLock.source, targetRepo);

            if (info.commitSha === oldLock.commitSha && info.depsLockSha === oldLock.depsLockSha) {
              if (dryRun) yield* cleanup;
              return {
                agentRoot: root,
                kind: "no-change" as const,
                oldCommitSha: oldLock.commitSha,
                newCommitSha: info.commitSha,
                oldPiSlot: oldLock.piSlot,
                newPiSlot: oldLock.piSlot,
                source: info.source,
              };
            }

            if (opts?.frozen === true) {
              if (dryRun) yield* cleanup;
              return yield* Effect.fail(
                new FrozenDriftError({
                  agentRoot: root,
                  message: `--frozen drift for ${root}: lockfile pinned at ${oldLock.commitSha}, resolved ${info.commitSha}`,
                }),
              );
            }

            const detection = yield* detector.detect(targetRepo);
            const reg = yield* registry.read;
            const existingEntries = reg.agents.filter(
              (a) => a.name === root || a.name.startsWith(`${root}:`),
            );
            const oldShape = existingEntries[0]?.shape;
            if (oldShape && oldShape !== detection.kind) {
              if (dryRun) yield* cleanup;
              return yield* Effect.fail(
                new InvalidShapeError({
                  source: oldLock.source,
                  message: `shape changed from ${oldShape} to ${detection.kind}; run \`pihub remove ${root} && pihub install ${oldLock.source}\` to migrate`,
                }),
              );
            }

            const newPiSlot =
              detection.kind === "alpha" && detection.info.piRange
                ? (extractPiMinor(detection.info.piRange) ?? DEFAULT_PI_SLOT)
                : oldLock.piSlot || DEFAULT_PI_SLOT;

            if (dryRun) {
              yield* cleanup;
              return {
                agentRoot: root,
                kind: "dry-run-would-apply" as const,
                oldCommitSha: oldLock.commitSha,
                newCommitSha: info.commitSha,
                oldPiSlot: oldLock.piSlot,
                newPiSlot,
                source: info.source,
              };
            }

            const manifest = yield* manifestParser.parse(repoPath);

            // α-shaped agents need a fresh `pi install` against the (possibly
            // bumped) runtime slot.
            if (detection.kind === "alpha") {
              const piBinary = yield* runtime.ensureSlot(newPiSlot);
              yield* piInstaller.install(piBinary, repoPath, profilePath);
            }

            const entries: ReadonlyArray<RegistryEntry> =
              detection.kind === "alpha"
                ? [buildAlphaEntry(root, detection.info, info, manifest, newPiSlot)]
                : detection.agents.map((a) => buildBetaEntry(root, a, info, manifest, newPiSlot));

            yield* lockStore.write(root, {
              source: info.source,
              ref: info.ref,
              commitSha: info.commitSha,
              piSlot: newPiSlot,
              depsLockSha: info.depsLockSha,
              installedAt: new Date().toISOString(),
              link: info.link,
            });
            yield* registry.upsertAgents(entries);

            return {
              agentRoot: root,
              kind: "applied" as const,
              oldCommitSha: oldLock.commitSha,
              newCommitSha: info.commitSha,
              oldPiSlot: oldLock.piSlot,
              newPiSlot,
              source: info.source,
            };
          } catch (e) {
            if (dryRun) yield* cleanup;
            throw e;
          }
        });

      // Reference fs to keep the unused-import lint happy if no Live path
      // uses it (currently the dry-run cleanup path does, indirectly).
      void fs;

      return {
        update: updateOne,
        updateAll: (opts) =>
          Effect.gen(function* () {
            const reg = yield* registry.read;
            const roots = Array.from(new Set(reg.agents.map((a) => agentRootOf(a.name)))).sort();
            const out: Array<{ agentRoot: string; result?: UpdateResult; error?: string }> = [];
            for (const root of roots) {
              const exit = yield* Effect.exit(updateOne(root, opts));
              if (exit._tag === "Success") {
                out.push({ agentRoot: root, result: exit.value });
              } else {
                out.push({ agentRoot: root, error: JSON.stringify(exit.cause) });
              }
            }
            return out;
          }),
      } satisfies UpdaterShape;
    }),
  );
}
