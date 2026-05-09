import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Ref } from "effect";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { CopyError, SourceNotFoundError } from "../errors.js";
import type { SourceInfo } from "../types.js";

/**
 * Slice #3 supports only local paths. Remote URL kinds (`github:`, `https://`,
 * `npm:`, …) come in slices #4 and #5 — see CONTEXT.md "Source URL kinds".
 */
const isLocalPath = (source: string): boolean =>
  source.startsWith("./") || source.startsWith("../") || path.isAbsolute(source) || source === ".";

export interface SourceFetcherShape {
  readonly fetch: (
    source: string,
    dest: string,
  ) => Effect.Effect<SourceInfo, SourceNotFoundError | CopyError>;
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

export class SourceFetcher extends Context.Tag("SourceFetcher")<
  SourceFetcher,
  SourceFetcherShape
>() {
  static readonly Live = Layer.effect(
    SourceFetcher,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return SourceFetcher.of({
        fetch: (source, dest) =>
          Effect.gen(function* () {
            if (!isLocalPath(source)) {
              return yield* Effect.fail(
                new SourceNotFoundError({
                  source,
                  message: `slice #3 supports only local paths; remote URL kinds land in slices #4 and #5`,
                }),
              );
            }
            const absSource = path.resolve(source);
            const exists = yield* fs.exists(absSource).pipe(Effect.orElseSucceed(() => false));
            if (!exists) {
              return yield* Effect.fail(
                new SourceNotFoundError({
                  source,
                  message: `local path does not exist: ${absSource}`,
                }),
              );
            }
            // Wipe destination so the copy is a true mirror — avoids stale files.
            yield* fs.remove(dest, { recursive: true, force: true }).pipe(Effect.ignore);
            yield* copyTree(fs, absSource, dest);
            const commitSha = yield* walkAndHash(fs, dest);
            const depsLockSha = yield* lockfileSha(fs, dest);
            return {
              source: absSource,
              ref: `tree-${commitSha.slice(0, 12)}`,
              commitSha,
              depsLockSha,
            };
          }),
      });
    }),
  );

  /**
   * Test layer that records every call and returns canned info. The recorder
   * Ref is exposed via `accessRecorder` so tests can assert call patterns.
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
