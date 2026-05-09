import { FileSystem } from "@effect/platform";
import { Manifest, RegistryEntry, emptyManifest } from "@pihub/schema";
import { Context, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import {
  CopyError,
  FrontmatterParseError,
  GitCloneError,
  GithubApiError,
  InvalidShapeError,
  LinkSourceUnsupportedError,
  ManifestParseError,
  NpmVersionNotFoundError,
  PiInstallError,
  RefNotFoundError,
  SourceFetchError,
  SourceNotFoundError,
} from "../errors.js";
import { extractPiMinor, parseSource } from "../lib/parse-source.js";
import { Paths } from "../paths.js";
import type { AlphaAgentInfo, BetaAgentInfo, SourceInfo } from "../types.js";
import { type InvokeOptions, type InvokeResult, Invoker, type InvokerError } from "./invoker.js";
import { ManifestParser } from "./manifest-parser.js";
import { PiInstaller } from "./pi-installer.js";
import { RuntimeSlotManager } from "./runtime-slot.js";
import { ShapeDetector } from "./shape-detector.js";
import { SourceFetcher } from "./source-fetcher.js";

export type EphemeralRunnerError =
  | InvokerError
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
  | LinkSourceUnsupportedError;

export interface EphemeralRunnerShape {
  /**
   * Clone or copy `source`, detect shape, ensure runtime slot, run pi against
   * `task`, then delete the tempdir. No registry/lockfile state changes.
   * Failures, aborts, and timeouts all release the tempdir via `Effect.scoped`.
   */
  readonly run: (
    source: string,
    task: string,
    opts?: InvokeOptions,
  ) => Effect.Effect<InvokeResult, EphemeralRunnerError>;
}

const DEFAULT_PI_SLOT = "0.74";

/**
 * Derive an ephemeral agent name. Used for the synthetic RegistryEntry that
 * `Invoker.invokeEntry` consumes — purely cosmetic; never persisted.
 */
const ephemeralName = (source: string): string => {
  const parsed = parseSource(source);
  if (parsed?.kind === "github") return `${parsed.owner}/${parsed.repo}`;
  if (parsed?.kind === "npm") return parsed.packageName;
  if (parsed?.kind === "local") {
    return path.basename(parsed.absolutePath.replace(/\/+$/, ""));
  }
  return "ephemeral";
};

const buildEntryFromBeta = (
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
    invoke: `pihub run ${info.source} "<task>"`,
    envDeclared: manifest.env ? [...manifest.env] : [],
    linked: info.link,
    permissions: manifest.permissions ? [...manifest.permissions] : [],
  };
  if (manifest.timeoutSeconds !== undefined) {
    (entry as { timeoutSeconds: number }).timeoutSeconds = manifest.timeoutSeconds;
  }
  return entry;
};

const buildEntryFromAlpha = (
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
    invoke: `pihub run ${info.source} "<task>"`,
    envDeclared: manifest.env ? [...manifest.env] : [],
    linked: info.link,
    permissions: manifest.permissions ? [...manifest.permissions] : [],
  };
  if (manifest.timeoutSeconds !== undefined) {
    (entry as { timeoutSeconds: number }).timeoutSeconds = manifest.timeoutSeconds;
  }
  return entry;
};

export class EphemeralRunner extends Context.Tag("EphemeralRunner")<
  EphemeralRunner,
  EphemeralRunnerShape
>() {
  static readonly Live = Layer.effect(
    EphemeralRunner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      const fetcher = yield* SourceFetcher;
      const detector = yield* ShapeDetector;
      const manifestParser = yield* ManifestParser;
      const runtime = yield* RuntimeSlotManager;
      const piInstaller = yield* PiInstaller;
      const invoker = yield* Invoker;

      return {
        run: (source, task, opts) =>
          Effect.scoped(
            Effect.gen(function* () {
              const id = randomUUID();
              const root = path.join(paths.ephemeralRoot, id);
              const repoPath = path.join(root, "repo");
              const profilePath = path.join(root, "profile");

              // Acquire-release the ephemeral root so cleanup runs on success,
              // failure, abort, and timeout — same scope discipline as
              // --sandbox in slice #12.
              yield* Effect.acquireRelease(
                fs.makeDirectory(root, { recursive: true }).pipe(
                  Effect.mapError(
                    (e) =>
                      new SourceFetchError({
                        source,
                        message: `failed to create ephemeral root ${root}: ${String(e)}`,
                      }),
                  ),
                ),
                () =>
                  Effect.promise(() =>
                    import("node:fs/promises").then((m) =>
                      m.rm(root, { recursive: true, force: true }),
                    ),
                  ).pipe(Effect.ignore),
              );

              const info = yield* fetcher.fetch(source, repoPath);
              const detection = yield* detector.detect(repoPath);
              const manifest = yield* manifestParser
                .parse(repoPath)
                .pipe(Effect.orElseSucceed(() => emptyManifest));
              yield* fs.makeDirectory(profilePath, { recursive: true }).pipe(
                Effect.mapError(
                  (e) =>
                    new SourceFetchError({
                      source,
                      message: `failed to create ephemeral profile ${profilePath}: ${String(e)}`,
                    }),
                ),
              );

              const piSlot =
                detection.kind === "alpha" && detection.info.piRange
                  ? (extractPiMinor(detection.info.piRange) ?? DEFAULT_PI_SLOT)
                  : DEFAULT_PI_SLOT;

              const agentRoot = ephemeralName(source);

              if (detection.kind === "alpha") {
                const piBinary = yield* runtime.ensureSlot(piSlot);
                yield* piInstaller.install(piBinary, repoPath, profilePath);
              }

              const entry =
                detection.kind === "alpha"
                  ? buildEntryFromAlpha(agentRoot, detection.info, info, manifest, piSlot)
                  : (() => {
                      // β can have multiple sub-agents; for `pihub run`, pick
                      // the first deterministic one. Future revision could
                      // support `pihub run <source>:<sub>`.
                      const first = detection.agents[0];
                      if (!first) {
                        throw new Error("β detection returned zero agents");
                      }
                      return buildEntryFromBeta(agentRoot, first, info, manifest, piSlot);
                    })();

              return yield* invoker.invokeEntry({ entry, profilePath, skipLog: true }, task, opts);
            }),
          ),
      } satisfies EphemeralRunnerShape;
    }),
  );
}
