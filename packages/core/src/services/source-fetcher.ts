import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Ref } from "effect";
import { createHash } from "node:crypto";
import * as path from "node:path";
import {
  CopyError,
  GitCloneError,
  GithubApiError,
  RefNotFoundError,
  SourceFetchError,
  SourceNotFoundError,
} from "../errors.js";
import {
  isCommitSha,
  parseSource,
  pickHighestSemverTag,
  type ParsedSource,
} from "../lib/parse-source.js";
import type { SourceInfo } from "../types.js";
import { GithubApi } from "./github-api.js";
import { GitClient } from "./git-client.js";

export type SourceFetcherError =
  | SourceNotFoundError
  | SourceFetchError
  | CopyError
  | GithubApiError
  | RefNotFoundError
  | GitCloneError;

export interface SourceFetcherShape {
  readonly fetch: (source: string, dest: string) => Effect.Effect<SourceInfo, SourceFetcherError>;
}

const walkAndHash = (fs: FileSystem.FileSystem, root: string): Effect.Effect<string, CopyError> =>
  Effect.gen(function* () {
    const hash = createHash("sha256");
    const stack: string[] = [root];
    const collected: Array<{ rel: string; isDir: boolean; bytes?: Uint8Array }> = [];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      const stat = yield* fs.stat(current).pipe(
        Effect.mapError(
          (e) =>
            new CopyError({
              source: root,
              dest: "",
              message: `stat failed for ${current}: ${String(e)}`,
            }),
        ),
      );
      const rel = path.relative(root, current);
      if (stat.type === "Directory") {
        collected.push({ rel, isDir: true });
        const entries = yield* fs.readDirectory(current).pipe(
          Effect.mapError(
            (e) =>
              new CopyError({
                source: root,
                dest: "",
                message: `readDirectory failed for ${current}: ${String(e)}`,
              }),
          ),
        );
        for (const entry of entries) stack.push(path.join(current, entry));
      } else if (stat.type === "File") {
        const bytes = yield* fs.readFile(current).pipe(
          Effect.mapError(
            (e) =>
              new CopyError({
                source: root,
                dest: "",
                message: `readFile failed for ${current}: ${String(e)}`,
              }),
          ),
        );
        collected.push({ rel, isDir: false, bytes });
      }
    }
    collected.sort((a, b) => a.rel.localeCompare(b.rel));
    for (const item of collected) {
      hash.update(item.isDir ? `D:${item.rel}\n` : `F:${item.rel}:`);
      if (item.bytes) hash.update(item.bytes);
      hash.update("\n");
    }
    return hash.digest("hex");
  });

const copyTree = (
  fs: FileSystem.FileSystem,
  src: string,
  dst: string,
): Effect.Effect<void, CopyError> =>
  Effect.gen(function* () {
    const stat = yield* fs
      .stat(src)
      .pipe(
        Effect.mapError(
          (e) => new CopyError({ source: src, dest: dst, message: `stat failed: ${String(e)}` }),
        ),
      );
    if (stat.type === "Directory") {
      yield* fs
        .makeDirectory(dst, { recursive: true })
        .pipe(
          Effect.mapError(
            (e) => new CopyError({ source: src, dest: dst, message: `mkdir failed: ${String(e)}` }),
          ),
        );
      const entries = yield* fs.readDirectory(src).pipe(
        Effect.mapError(
          (e) =>
            new CopyError({
              source: src,
              dest: dst,
              message: `readDirectory failed: ${String(e)}`,
            }),
        ),
      );
      for (const entry of entries) {
        yield* copyTree(fs, path.join(src, entry), path.join(dst, entry));
      }
    } else if (stat.type === "File") {
      const bytes = yield* fs
        .readFile(src)
        .pipe(
          Effect.mapError(
            (e) =>
              new CopyError({ source: src, dest: dst, message: `readFile failed: ${String(e)}` }),
          ),
        );
      yield* fs
        .writeFile(dst, bytes)
        .pipe(
          Effect.mapError(
            (e) =>
              new CopyError({ source: src, dest: dst, message: `writeFile failed: ${String(e)}` }),
          ),
        );
    }
  });

const lockfileSha = (
  fs: FileSystem.FileSystem,
  sourceDir: string,
): Effect.Effect<string, CopyError> =>
  Effect.gen(function* () {
    const candidates = ["bun.lock", "bun.lockb", "package-lock.json", "yarn.lock"];
    for (const file of candidates) {
      const filePath = path.join(sourceDir, file);
      const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        const bytes = yield* fs.readFile(filePath).pipe(
          Effect.mapError(
            (e) =>
              new CopyError({
                source: filePath,
                dest: "",
                message: `lockfile read failed: ${String(e)}`,
              }),
          ),
        );
        return createHash("sha256").update(bytes).digest("hex");
      }
    }
    return "";
  });

const fetchLocal = (
  fs: FileSystem.FileSystem,
  parsed: Extract<ParsedSource, { kind: "local" }>,
  rawSource: string,
  dest: string,
): Effect.Effect<SourceInfo, SourceNotFoundError | CopyError> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(parsed.absolutePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* Effect.fail(
        new SourceNotFoundError({
          source: rawSource,
          message: `local path does not exist: ${parsed.absolutePath}`,
        }),
      );
    }
    yield* fs.remove(dest, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* copyTree(fs, parsed.absolutePath, dest);
    const commitSha = yield* walkAndHash(fs, dest);
    const depsLockSha = yield* lockfileSha(fs, dest);
    return {
      source: parsed.absolutePath,
      ref: `tree-${commitSha.slice(0, 12)}`,
      commitSha,
      depsLockSha,
    };
  });

const resolveDefaultRef = (
  api: typeof GithubApi.Service,
  owner: string,
  repo: string,
): Effect.Effect<string, GithubApiError | RefNotFoundError> =>
  Effect.gen(function* () {
    const tags = yield* api.listTags(owner, repo);
    const semver = pickHighestSemverTag(tags);
    if (semver) return semver;
    return yield* api.getDefaultBranch(owner, repo);
  });

const fetchGithub = (
  fs: FileSystem.FileSystem,
  api: typeof GithubApi.Service,
  git: typeof GitClient.Service,
  parsed: Extract<ParsedSource, { kind: "github" }>,
  dest: string,
): Effect.Effect<
  SourceInfo,
  SourceFetchError | CopyError | GithubApiError | RefNotFoundError | GitCloneError
> =>
  Effect.gen(function* () {
    const requestedRef = parsed.ref ?? (yield* resolveDefaultRef(api, parsed.owner, parsed.repo));
    const commitSha = isCommitSha(requestedRef)
      ? requestedRef
      : yield* api.resolveCommitSha(parsed.owner, parsed.repo, requestedRef);
    const cloneUrl = `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    yield* fs.remove(dest, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* fs.makeDirectory(path.dirname(dest), { recursive: true }).pipe(
      Effect.mapError(
        (e) =>
          new SourceFetchError({
            source: parsed.normalized,
            message: `failed to mkdir parent of ${dest}: ${String(e)}`,
          }),
      ),
    );
    yield* git.clone(cloneUrl, dest, commitSha);
    const depsLockSha = yield* lockfileSha(fs, dest);
    return {
      source: parsed.normalized,
      ref: requestedRef,
      commitSha,
      depsLockSha,
    };
  });

export class SourceFetcher extends Context.Tag("SourceFetcher")<
  SourceFetcher,
  SourceFetcherShape
>() {
  static readonly Live = Layer.effect(
    SourceFetcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const api = yield* GithubApi;
      const git = yield* GitClient;
      return SourceFetcher.of({
        fetch: (source, dest) =>
          Effect.gen(function* () {
            const parsed = parseSource(source);
            if (!parsed) {
              return yield* Effect.fail(
                new SourceNotFoundError({
                  source,
                  message:
                    "unrecognised source — supported kinds: github:owner/repo[@ref], https://github.com/owner/repo[@ref], local path",
                }),
              );
            }
            if (parsed.kind === "local") return yield* fetchLocal(fs, parsed, source, dest);
            return yield* fetchGithub(fs, api, git, parsed, dest);
          }),
      });
    }),
  );

  /**
   * Test layer that records every call and returns canned info. Default
   * fallback if a source is not seeded: a synthetic SourceInfo so the test
   * exercises the orchestration without coupling to the URL parser.
   */
  static readonly Test = (seed: ReadonlyMap<string, SourceInfo> = new Map()) =>
    Layer.effect(
      SourceFetcher,
      Effect.gen(function* () {
        const calls = yield* Ref.make<Array<{ source: string; dest: string }>>([]);
        const seedMap = new Map(seed);
        return SourceFetcher.of({
          fetch: (source, dest) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (xs) => [...xs, { source, dest }]);
              const hit = seedMap.get(source);
              if (hit) return hit;
              return {
                source,
                ref: "tree-test",
                commitSha: "test-commit-sha",
                depsLockSha: "",
              } satisfies SourceInfo;
            }),
        });
      }),
    );
}
