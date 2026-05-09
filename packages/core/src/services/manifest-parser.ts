import { FileSystem } from "@effect/platform";
import { Manifest, emptyManifest } from "@pihub/schema";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import * as path from "node:path";
import { ManifestParseError } from "../errors.js";

const MANIFEST_FILE = "pihub.json";
const decodeManifest = Schema.decodeUnknown(Schema.parseJson(Manifest));

export interface ManifestParserShape {
  readonly parse: (sourceDir: string) => Effect.Effect<Manifest, ManifestParseError>;
}

export class ManifestParser extends Context.Tag("ManifestParser")<
  ManifestParser,
  ManifestParserShape
>() {
  static readonly Live = Layer.effect(
    ManifestParser,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ManifestParser.of({
        parse: (sourceDir) =>
          Effect.gen(function* () {
            const manifestPath = path.join(sourceDir, MANIFEST_FILE);
            const exists = yield* fs.exists(manifestPath).pipe(Effect.orElseSucceed(() => false));
            if (!exists) return emptyManifest;
            const raw = yield* fs.readFileString(manifestPath).pipe(
              Effect.mapError(
                (e) =>
                  new ManifestParseError({
                    path: manifestPath,
                    message: `failed to read pihub.json: ${String(e)}`,
                  }),
              ),
            );
            return yield* decodeManifest(raw).pipe(
              Effect.mapError(
                (e) =>
                  new ManifestParseError({
                    path: manifestPath,
                    message: `pihub.json validation failed: ${e.message}`,
                  }),
              ),
            );
          }),
      });
    }),
  );

  static readonly Test = (seed: ReadonlyMap<string, Manifest> = new Map()) =>
    Layer.effect(
      ManifestParser,
      Effect.gen(function* () {
        const store = yield* Ref.make(new Map(seed));
        return ManifestParser.of({
          parse: (sourceDir) =>
            Ref.get(store).pipe(Effect.map((m) => m.get(sourceDir) ?? emptyManifest)),
        });
      }),
    );
}
