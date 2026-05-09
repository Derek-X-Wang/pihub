import { FileSystem } from "@effect/platform";
import { Aliases, emptyAliases } from "@pihub/schema";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import * as path from "node:path";
import { AliasCollisionError, AliasNotFoundError, AliasStoreError } from "../errors.js";
import { Paths } from "../paths.js";
import { RegistryStore } from "./registry-store.js";

const decodeAliases = Schema.decodeUnknown(Schema.parseJson(Aliases));
const encodeAliases = (a: Aliases) => JSON.stringify(a, null, 2) + "\n";

export interface AliasStoreShape {
  readonly read: Effect.Effect<Aliases, AliasStoreError>;
  /** Adds or replaces — caller should check collision before calling if `overwrite=false`. */
  readonly set: (
    short: string,
    canonical: string,
  ) => Effect.Effect<void, AliasStoreError | AliasCollisionError>;
  readonly remove: (short: string) => Effect.Effect<void, AliasStoreError | AliasNotFoundError>;
  /**
   * Remove every alias whose value (canonical name) matches `canonical` —
   * either the agent root (`<owner>/<repo>`) or one of its sub-agent ids
   * (`<owner>/<repo>:<sub>`). Returns the shorts that were dropped.
   */
  readonly removeForCanonical: (
    canonical: string,
  ) => Effect.Effect<ReadonlyArray<string>, AliasStoreError>;
  /**
   * Resolves a name through the alias map. Returns `name` unchanged when no
   * alias is set, so callers can chain "alias → registry lookup".
   */
  readonly resolve: (name: string) => Effect.Effect<string, AliasStoreError>;
}

export class AliasStore extends Context.Tag("AliasStore")<AliasStore, AliasStoreShape>() {
  static readonly Live = Layer.effect(
    AliasStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      const registry = yield* RegistryStore;

      const read: Effect.Effect<Aliases, AliasStoreError> = Effect.gen(function* () {
        const exists = yield* fs.exists(paths.aliases).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return emptyAliases;
        const raw = yield* fs.readFileString(paths.aliases).pipe(
          Effect.mapError(
            (e) =>
              new AliasStoreError({
                message: `failed to read ${paths.aliases}: ${String(e)}`,
              }),
          ),
        );
        return yield* decodeAliases(raw).pipe(
          Effect.mapError(
            (e) =>
              new AliasStoreError({
                message: `aliases.json validation failed: ${e.message}`,
              }),
          ),
        );
      });

      const write = (a: Aliases): Effect.Effect<void, AliasStoreError> =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(paths.aliases), { recursive: true }).pipe(
            Effect.mapError(
              (e) =>
                new AliasStoreError({
                  message: `failed to mkdir for ${paths.aliases}: ${String(e)}`,
                }),
            ),
          );
          yield* fs.writeFileString(paths.aliases, encodeAliases(a)).pipe(
            Effect.mapError(
              (e) =>
                new AliasStoreError({
                  message: `failed to write ${paths.aliases}: ${String(e)}`,
                }),
            ),
          );
        });

      return {
        read,
        set: (short, canonical) =>
          Effect.gen(function* () {
            const cur = yield* read;
            if (Object.prototype.hasOwnProperty.call(cur.map, short)) {
              return yield* Effect.fail(
                new AliasCollisionError({
                  name: short,
                  message: `alias '${short}' already maps to '${cur.map[short]}'; remove it first`,
                }),
              );
            }
            // Also reject `<short>` that collides with a canonical name in the
            // registry — callers reading `pihub invoke <short>` should see the
            // alias unambiguously.
            const reg = yield* registry.read.pipe(
              Effect.mapError(
                (e) =>
                  new AliasStoreError({
                    message: `failed to read registry while validating alias: ${e.message}`,
                  }),
              ),
            );
            if (reg.agents.some((a) => a.name === short)) {
              return yield* Effect.fail(
                new AliasCollisionError({
                  name: short,
                  message: `'${short}' is a canonical agent name; aliases must be distinct`,
                }),
              );
            }
            yield* write({ ...cur, map: { ...cur.map, [short]: canonical } });
          }),
        remove: (short) =>
          Effect.gen(function* () {
            const cur = yield* read;
            if (!Object.prototype.hasOwnProperty.call(cur.map, short)) {
              return yield* Effect.fail(
                new AliasNotFoundError({
                  name: short,
                  message: `no alias named '${short}'`,
                }),
              );
            }
            const next = { ...cur.map };
            delete next[short];
            yield* write({ ...cur, map: next });
          }),
        removeForCanonical: (canonical) =>
          Effect.gen(function* () {
            const cur = yield* read;
            const dropped: Array<string> = [];
            const next: Record<string, string> = {};
            for (const [short, value] of Object.entries(cur.map)) {
              if (value === canonical || value.startsWith(`${canonical}:`)) {
                dropped.push(short);
              } else {
                next[short] = value;
              }
            }
            if (dropped.length > 0) {
              yield* write({ ...cur, map: next });
            }
            return dropped;
          }),
        resolve: (name) => read.pipe(Effect.map((a) => a.map[name] ?? name)),
      } satisfies AliasStoreShape;
    }),
  );

  static readonly Test = (seed: ReadonlyMap<string, string> = new Map()) =>
    Layer.effect(
      AliasStore,
      Effect.gen(function* () {
        const store = yield* Ref.make<Aliases>({
          version: emptyAliases.version,
          map: Object.fromEntries(seed),
        });
        return {
          read: Ref.get(store),
          set: (short, canonical) =>
            Effect.gen(function* () {
              const cur = yield* Ref.get(store);
              if (Object.prototype.hasOwnProperty.call(cur.map, short)) {
                return yield* Effect.fail(
                  new AliasCollisionError({
                    name: short,
                    message: `alias '${short}' already maps to '${cur.map[short]}'`,
                  }),
                );
              }
              yield* Ref.update(store, (a) => ({
                ...a,
                map: { ...a.map, [short]: canonical },
              }));
            }),
          remove: (short) =>
            Effect.gen(function* () {
              const cur = yield* Ref.get(store);
              if (!Object.prototype.hasOwnProperty.call(cur.map, short)) {
                return yield* Effect.fail(
                  new AliasNotFoundError({ name: short, message: `no alias named '${short}'` }),
                );
              }
              yield* Ref.update(store, (a) => {
                const next = { ...a.map };
                delete next[short];
                return { ...a, map: next };
              });
            }),
          removeForCanonical: (canonical) =>
            Effect.gen(function* () {
              const cur = yield* Ref.get(store);
              const dropped: Array<string> = [];
              const next: Record<string, string> = {};
              for (const [short, value] of Object.entries(cur.map)) {
                if (value === canonical || value.startsWith(`${canonical}:`)) {
                  dropped.push(short);
                } else {
                  next[short] = value;
                }
              }
              if (dropped.length > 0) {
                yield* Ref.update(store, (a) => ({ ...a, map: next }));
              }
              return dropped;
            }),
          resolve: (name) => Ref.get(store).pipe(Effect.map((a) => a.map[name] ?? name)),
        } satisfies AliasStoreShape;
      }),
    );
}
