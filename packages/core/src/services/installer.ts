import { Manifest, RegistryEntry } from "@pihub/schema";
import { Context, Effect, Layer, Option } from "effect";
import * as path from "node:path";
import {
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
  ProfileError,
  RefNotFoundError,
  RegistryError,
  RuntimeSlotError,
  SourceFetchError,
  SourceNotFoundError,
} from "../errors.js";
import { extractPiMinor, parseSource } from "../lib/parse-source.js";
import { Paths } from "../paths.js";
import type { AlphaAgentInfo, BetaAgentInfo, InstallOptions, SourceInfo } from "../types.js";
import { LockfileStore } from "./lockfile-store.js";
import { ManifestParser } from "./manifest-parser.js";
import { PiInstaller } from "./pi-installer.js";
import { Profile } from "./profile.js";
import { RegistryStore } from "./registry-store.js";
import { RuntimeSlotManager } from "./runtime-slot.js";
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
  | RegistryError
  | SourceFetchError
  | GithubApiError
  | RefNotFoundError
  | GitCloneError
  | NpmVersionNotFoundError
  | FrozenDriftError
  | LinkSourceUnsupportedError
  | RuntimeSlotError
  | PiInstallError;

export interface InstallResult {
  readonly agentRoot: string;
  readonly entries: ReadonlyArray<RegistryEntry>;
  readonly cached: boolean;
}

export interface InstallerShape {
  readonly install: (
    source: string,
    opts?: InstallOptions,
  ) => Effect.Effect<InstallResult, InstallerError>;
}

/**
 * Derive the canonical agent-root name from a source URL or local path:
 * - github → `<owner>/<repo>`
 * - npm    → `<package>` (preserves leading `@scope/` for scoped packages)
 * - local  → directory basename
 *
 * The `:` separator for sub-agents (β) is appended later when registry
 * entries are built.
 */
const computeAgentRoot = (source: string): string => {
  const parsed = parseSource(source);
  if (parsed?.kind === "github") return `${parsed.owner}/${parsed.repo}`;
  if (parsed?.kind === "npm") return parsed.packageName;
  if (parsed?.kind === "local") {
    return path.basename(parsed.absolutePath.replace(/\/+$/, ""));
  }
  // Fallback path: keep the legacy behaviour for unrecognised inputs so the
  // ensuing SourceFetcher.fetch produces a clean SourceNotFoundError.
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
    linked: info.link,
    permissions: manifest.permissions ? [...manifest.permissions] : [],
  };
};

const buildAlphaEntry = (
  agentRoot: string,
  alpha: AlphaAgentInfo,
  info: SourceInfo,
  manifest: Manifest,
  piSlot: string,
): RegistryEntry => ({
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
});

/**
 * Default Pi runtime slot until slice #17 implements per-agent minor
 * resolution from the agent's `package.json` deps. The label is the
 * minor-version directory key under `~/.pihub/runtime/pi/<minor>/`.
 *
 * 0.74 is the current pi-coding-agent minor at the time of this slice; bump
 * via `pihub upgrade-runtime` once that command lands (slice #17).
 */
const DEFAULT_PI_SLOT = "0.74";

const resolvePiSlot = (alpha: AlphaAgentInfo): string => {
  if (alpha.piRange) {
    const minor = extractPiMinor(alpha.piRange);
    if (minor) return minor;
  }
  return DEFAULT_PI_SLOT;
};

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
      const runtimeSlots = yield* RuntimeSlotManager;
      const piInstaller = yield* PiInstaller;
      const paths = yield* Paths;

      return Installer.of({
        install: (source, opts) =>
          Effect.gen(function* () {
            const agentRoot = computeAgentRoot(source);
            const repoPath = paths.agentRepo(agentRoot);
            const profilePath = paths.agentProfile(agentRoot);
            const link = opts?.link === true;
            const frozen = opts?.frozen === true;

            if (link) {
              const parsed = parseSource(source);
              if (parsed && parsed.kind !== "local") {
                return yield* Effect.fail(
                  new LinkSourceUnsupportedError({
                    source,
                    message: `--link is only valid with local-path sources; got kind=${parsed.kind}`,
                  }),
                );
              }
            }

            const info = yield* fetcher.fetch(source, repoPath, link ? { link: true } : undefined);
            const detection = yield* detector.detect(repoPath);
            const manifest = yield* manifestParser.parse(repoPath);
            yield* profile.ensure(agentRoot);

            // Build the registry entries for whichever shape was detected.
            const piSlot =
              detection.kind === "alpha" ? resolvePiSlot(detection.info) : DEFAULT_PI_SLOT;
            const entries: ReadonlyArray<RegistryEntry> =
              detection.kind === "alpha"
                ? [buildAlphaEntry(agentRoot, detection.info, info, manifest, piSlot)]
                : detection.agents.map((a) => buildBetaEntry(agentRoot, a, info, manifest, piSlot));

            const existingLock = yield* lockStore.read(agentRoot);
            const cached = Option.match(existingLock, {
              onNone: () => false,
              onSome: (lock) =>
                lock.source === info.source &&
                lock.commitSha === info.commitSha &&
                lock.depsLockSha === info.depsLockSha &&
                lock.link === info.link,
            });

            if (frozen) {
              if (Option.isNone(existingLock)) {
                return yield* Effect.fail(
                  new FrozenDriftError({
                    agentRoot,
                    message: `--frozen requires an existing lockfile for ${agentRoot}, but none exists`,
                  }),
                );
              }
              if (!cached) {
                const lock = existingLock.value;
                return yield* Effect.fail(
                  new FrozenDriftError({
                    agentRoot,
                    message: `--frozen drift for ${agentRoot}: lockfile pinned at ${lock.commitSha}, resolved ${info.commitSha}`,
                  }),
                );
              }
              const reg = yield* registry.read;
              const existing = reg.agents.filter(
                (a) => a.name === agentRoot || a.name.startsWith(`${agentRoot}:`),
              );
              return {
                agentRoot,
                entries: existing.length > 0 ? existing : entries,
                cached: true,
              } satisfies InstallResult;
            }

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

            // Shape-α side-effect: ensure the runtime slot is populated and
            // run `pi install <repo>` against this agent's profile so Pi
            // loads the agent's extensions/skills/prompts/themes when invoked.
            if (detection.kind === "alpha") {
              const piBinary = yield* runtimeSlots.ensureSlot(piSlot);
              yield* piInstaller.install(piBinary, repoPath, profilePath);
            }

            yield* lockStore.write(agentRoot, {
              source: info.source,
              ref: info.ref,
              commitSha: info.commitSha,
              piSlot,
              depsLockSha: info.depsLockSha,
              installedAt: new Date().toISOString(),
              link: info.link,
            });
            yield* registry.upsertAgents(entries);

            return { agentRoot, entries, cached: false } satisfies InstallResult;
          }),
      });
    }),
  );
}
