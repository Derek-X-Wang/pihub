import { Context, Effect, Layer, Ref } from "effect";
import { unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SourceFetchError } from "../errors.js";

export interface TarExtractorShape {
  /**
   * Extract a `.tgz` (gzipped tarball) `bytes` blob into `dest`. `stripComponents`
   * matches GNU `tar --strip-components=N` — npm tarballs root the package
   * files under `package/`, so callers pass `1` to land them at the dest root.
   */
  readonly extract: (
    bytes: Uint8Array,
    dest: string,
    stripComponents: number,
  ) => Effect.Effect<void, SourceFetchError>;
}

export class TarExtractor extends Context.Tag("TarExtractor")<TarExtractor, TarExtractorShape>() {
  static readonly Live = Layer.succeed(TarExtractor, {
    extract: (bytes, dest, stripComponents) =>
      Effect.tryPromise({
        try: async () => {
          const tmp = path.join(
            os.tmpdir(),
            `pihub-npm-${Date.now()}-${Math.random().toString(36).slice(2)}.tgz`,
          );
          await writeFile(tmp, bytes);
          try {
            const proc = Bun.spawn(
              ["tar", "-xzf", tmp, "-C", dest, `--strip-components=${stripComponents}`],
              { stdout: "pipe", stderr: "pipe" },
            );
            const stderr = await new Response(proc.stderr).text();
            const code = await proc.exited;
            if (code !== 0) {
              throw new Error(`tar exited ${code}: ${stderr.trim()}`);
            }
          } finally {
            await unlink(tmp).catch(() => undefined);
          }
        },
        catch: (e) => new SourceFetchError({ source: "tarball", message: String(e) }),
      }),
  });

  /**
   * Test layer: records each extraction request without spawning tar. Tests
   * compose this with `NpmRegistry.Test` so the npm fetch path runs purely
   * in-memory and never touches the network or the tar binary.
   */
  static readonly Test = () =>
    Layer.effect(
      TarExtractor,
      Effect.gen(function* () {
        const calls = yield* Ref.make<
          Array<{ dest: string; stripComponents: number; size: number }>
        >([]);
        return {
          extract: (bytes, dest, stripComponents) =>
            Ref.update(calls, (xs) => [...xs, { dest, stripComponents, size: bytes.byteLength }]),
        } satisfies TarExtractorShape;
      }),
    );
}
