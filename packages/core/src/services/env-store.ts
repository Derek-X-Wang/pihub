import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Ref } from "effect";
import * as path from "node:path";
import { EnvFileError } from "../errors.js";
import { formatDotenv, parseDotenv } from "../lib/dotenv.js";

/**
 * Tagged-union "scope" for env operations. `global` writes to `~/.pihub/env`;
 * `agent` writes to `~/.pihub/agents/<name>/env`. The Paths service knows
 * the actual location; the store only cares about the scope.
 */
export type EnvScope =
  | { readonly kind: "global" }
  | { readonly kind: "agent"; readonly name: string };

export interface EnvStoreShape {
  readonly read: (filePath: string) => Effect.Effect<Record<string, string>, EnvFileError>;
  readonly write: (
    filePath: string,
    env: Record<string, string>,
  ) => Effect.Effect<void, EnvFileError>;
  readonly set: (filePath: string, key: string, value: string) => Effect.Effect<void, EnvFileError>;
  readonly unset: (filePath: string, key: string) => Effect.Effect<void, EnvFileError>;
}

const ENV_MODE = 0o600;

export class EnvStore extends Context.Tag("EnvStore")<EnvStore, EnvStoreShape>() {
  static readonly Live = Layer.effect(
    EnvStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;

      const read = (filePath: string) =>
        Effect.gen(function* () {
          const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
          if (!exists) return {} as Record<string, string>;
          const raw = yield* fs.readFileString(filePath).pipe(
            Effect.mapError(
              (e) =>
                new EnvFileError({
                  path: filePath,
                  message: `failed to read env file: ${String(e)}`,
                }),
            ),
          );
          return parseDotenv(raw);
        });

      const write = (filePath: string, env: Record<string, string>) =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
            Effect.mapError(
              (e) =>
                new EnvFileError({
                  path: filePath,
                  message: `failed to mkdir for ${filePath}: ${String(e)}`,
                }),
            ),
          );
          yield* fs.writeFileString(filePath, formatDotenv(env)).pipe(
            Effect.mapError(
              (e) =>
                new EnvFileError({
                  path: filePath,
                  message: `failed to write ${filePath}: ${String(e)}`,
                }),
            ),
          );
          // Enforce 0600 — secrets-only file. Any failure here is fatal so the
          // operator is never told "saved" when the file is world-readable.
          yield* fs.chmod(filePath, ENV_MODE).pipe(
            Effect.mapError(
              (e) =>
                new EnvFileError({
                  path: filePath,
                  message: `failed to chmod 0600 on ${filePath}: ${String(e)}`,
                }),
            ),
          );
        });

      return {
        read,
        write,
        set: (filePath, key, value) =>
          Effect.gen(function* () {
            const env = yield* read(filePath);
            env[key] = value;
            yield* write(filePath, env);
          }),
        unset: (filePath, key) =>
          Effect.gen(function* () {
            const env = yield* read(filePath);
            delete env[key];
            yield* write(filePath, env);
          }),
      } satisfies EnvStoreShape;
    }),
  );

  /**
   * Test layer with an in-memory Ref<Map<path, env>>. No real fs touches; mode
   * 0600 is implicit (the data never lands on disk).
   */
  static readonly Test = (seed: ReadonlyMap<string, Record<string, string>> = new Map()) =>
    Layer.effect(
      EnvStore,
      Effect.gen(function* () {
        const store = yield* Ref.make(new Map(seed));
        return {
          read: (filePath) =>
            Ref.get(store).pipe(Effect.map((m) => ({ ...m.get(filePath) }))),
          write: (filePath, env) =>
            Ref.update(store, (m) => new Map([...m, [filePath, { ...env }]])),
          set: (filePath, key, value) =>
            Ref.update(store, (m) => {
              const cur = m.get(filePath) ?? {};
              return new Map([...m, [filePath, { ...cur, [key]: value }]]);
            }),
          unset: (filePath, key) =>
            Ref.update(store, (m) => {
              const cur = { ...m.get(filePath) };
              delete cur[key];
              return new Map([...m, [filePath, cur]]);
            }),
        } satisfies EnvStoreShape;
      }),
    );
}
