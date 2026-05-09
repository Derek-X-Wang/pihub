import { FileSystem } from "@effect/platform";
import {
  CONFIG_KEYS,
  ConfigDefaults,
  PihubConfig,
  emptyPihubConfig,
  isConfigKey,
} from "@pihub/schema";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import * as path from "node:path";
import { ConfigInvalidError, ConfigStoreError } from "../errors.js";
import { Paths } from "../paths.js";

const decodeConfig = Schema.decodeUnknown(Schema.parseJson(PihubConfig));
const encodeConfig = (c: PihubConfig) => JSON.stringify(c, null, 2) + "\n";

const SEMVER_MINOR = /^\d+\.\d+$/;

const POSITIVE_INT_KEYS = new Set<keyof PihubConfig>([
  "timeout.default",
  "logs.retention",
  "install.parallel",
]);

export const validateValue = (
  key: keyof PihubConfig,
  raw: string,
): { ok: true; value: PihubConfig[keyof PihubConfig] } | { ok: false; reason: string } => {
  if (POSITIVE_INT_KEYS.has(key)) {
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { ok: false, reason: `expected positive integer, got '${raw}'` };
    }
    return { ok: true, value: n };
  }
  if (key === "runtime.defaultMinor") {
    if (!SEMVER_MINOR.test(raw)) {
      return { ok: false, reason: `expected semver minor like '0.74', got '${raw}'` };
    }
    return { ok: true, value: raw };
  }
  if (key === "network.githubToken") {
    if (raw.length === 0) {
      return { ok: false, reason: "value must be non-empty" };
    }
    return { ok: true, value: raw };
  }
  return { ok: false, reason: `unknown key` };
};

export interface ConfigStoreShape {
  readonly read: Effect.Effect<PihubConfig, ConfigStoreError>;
  readonly write: (c: PihubConfig) => Effect.Effect<void, ConfigStoreError>;
  /** Set a key after validation. Unknown keys → ConfigInvalidError. */
  readonly set: (
    key: string,
    rawValue: string,
  ) => Effect.Effect<void, ConfigStoreError | ConfigInvalidError>;
  readonly unset: (key: string) => Effect.Effect<void, ConfigStoreError | ConfigInvalidError>;
  /** Get a number value with default fallback. */
  readonly getNumber: (
    key: keyof PihubConfig & ("timeout.default" | "logs.retention" | "install.parallel"),
  ) => Effect.Effect<number, ConfigStoreError>;
  /** Get the configured GitHub token, or `undefined` if neither config nor env has it. */
  readonly getGithubToken: Effect.Effect<string | undefined, ConfigStoreError>;
  /** Get the default Pi minor (config wins over the bundled default). */
  readonly getDefaultPiMinor: Effect.Effect<string, ConfigStoreError>;
}

export class ConfigStore extends Context.Tag("ConfigStore")<ConfigStore, ConfigStoreShape>() {
  static readonly Live = Layer.effect(
    ConfigStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;

      const read: Effect.Effect<PihubConfig, ConfigStoreError> = Effect.gen(function* () {
        const exists = yield* fs.exists(paths.config).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return emptyPihubConfig;
        const raw = yield* fs.readFileString(paths.config).pipe(
          Effect.mapError(
            (e) =>
              new ConfigStoreError({
                message: `failed to read ${paths.config}: ${String(e)}`,
              }),
          ),
        );
        return yield* decodeConfig(raw).pipe(
          Effect.mapError(
            (e) =>
              new ConfigStoreError({
                message: `config validation failed: ${e.message}`,
              }),
          ),
        );
      });

      const write = (c: PihubConfig): Effect.Effect<void, ConfigStoreError> =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(paths.config), { recursive: true }).pipe(
            Effect.mapError(
              (e) =>
                new ConfigStoreError({
                  message: `failed to mkdir for ${paths.config}: ${String(e)}`,
                }),
            ),
          );
          yield* fs.writeFileString(paths.config, encodeConfig(c)).pipe(
            Effect.mapError(
              (e) =>
                new ConfigStoreError({
                  message: `failed to write ${paths.config}: ${String(e)}`,
                }),
            ),
          );
        });

      return {
        read,
        write,
        set: (key, rawValue) =>
          Effect.gen(function* () {
            if (!isConfigKey(key)) {
              return yield* Effect.fail(
                new ConfigInvalidError({
                  key,
                  message: `unknown key '${key}' — valid: ${CONFIG_KEYS.join(", ")}`,
                }),
              );
            }
            const v = validateValue(key, rawValue);
            if (!v.ok) {
              return yield* Effect.fail(new ConfigInvalidError({ key, message: v.reason }));
            }
            const cur = yield* read;
            yield* write({ ...cur, [key]: v.value } as PihubConfig);
          }),
        unset: (key) =>
          Effect.gen(function* () {
            if (!isConfigKey(key)) {
              return yield* Effect.fail(
                new ConfigInvalidError({
                  key,
                  message: `unknown key '${key}'`,
                }),
              );
            }
            const cur = yield* read;
            const next = { ...cur };
            delete next[key];
            yield* write(next);
          }),
        getNumber: (key) =>
          read.pipe(Effect.map((c) => (c[key] as number | undefined) ?? ConfigDefaults[key])),
        getGithubToken: read.pipe(
          Effect.map((c) => c["network.githubToken"] ?? process.env["GITHUB_TOKEN"] ?? undefined),
        ),
        getDefaultPiMinor: read.pipe(
          Effect.map((c) => c["runtime.defaultMinor"] ?? ConfigDefaults["runtime.defaultMinor"]),
        ),
      } satisfies ConfigStoreShape;
    }),
  );

  /** Test layer: in-memory PihubConfig with the same default-fallback behaviour. */
  static readonly Test = (initial: PihubConfig = emptyPihubConfig) =>
    Layer.effect(
      ConfigStore,
      Effect.gen(function* () {
        const store = yield* Ref.make<PihubConfig>({ ...initial });
        return {
          read: Ref.get(store),
          write: (c) => Ref.set(store, { ...c }),
          set: (key, rawValue) =>
            Effect.gen(function* () {
              if (!isConfigKey(key)) {
                return yield* Effect.fail(
                  new ConfigInvalidError({ key, message: `unknown key '${key}'` }),
                );
              }
              const v = validateValue(key, rawValue);
              if (!v.ok) {
                return yield* Effect.fail(new ConfigInvalidError({ key, message: v.reason }));
              }
              yield* Ref.update(store, (cur) => ({ ...cur, [key]: v.value }) as PihubConfig);
            }),
          unset: (key) =>
            Effect.gen(function* () {
              if (!isConfigKey(key)) {
                return yield* Effect.fail(
                  new ConfigInvalidError({ key, message: `unknown key '${key}'` }),
                );
              }
              yield* Ref.update(store, (cur) => {
                const next = { ...cur };
                delete next[key];
                return next;
              });
            }),
          getNumber: (key) =>
            Ref.get(store).pipe(
              Effect.map((c) => (c[key] as number | undefined) ?? ConfigDefaults[key]),
            ),
          getGithubToken: Ref.get(store).pipe(
            Effect.map((c) => c["network.githubToken"] ?? process.env["GITHUB_TOKEN"] ?? undefined),
          ),
          getDefaultPiMinor: Ref.get(store).pipe(
            Effect.map((c) => c["runtime.defaultMinor"] ?? ConfigDefaults["runtime.defaultMinor"]),
          ),
        } satisfies ConfigStoreShape;
      }),
    );
}
