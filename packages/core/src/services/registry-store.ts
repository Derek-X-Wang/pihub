import { FileSystem } from "@effect/platform";
import { Registry, RegistryEntry, emptyRegistry } from "@pihub/schema";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import * as path from "node:path";
import { RegistryError } from "../errors.js";
import { Paths } from "../paths.js";

const decodeRegistry = Schema.decodeUnknown(Schema.parseJson(Registry));
const encodeRegistry = (reg: Registry) => JSON.stringify(reg, null, 2) + "\n";

export interface RegistryStoreShape {
  readonly read: Effect.Effect<Registry, RegistryError>;
  readonly upsertAgents: (
    entries: ReadonlyArray<RegistryEntry>,
  ) => Effect.Effect<void, RegistryError>;
  readonly remove: (name: string) => Effect.Effect<void, RegistryError>;
}

const replaceEntries = (current: Registry, incoming: ReadonlyArray<RegistryEntry>): Registry => {
  const incomingNames = new Set(incoming.map((e) => e.name));
  const kept = current.agents.filter((a) => !incomingNames.has(a.name));
  return {
    ...current,
    agents: [...kept, ...incoming].sort((a, b) => a.name.localeCompare(b.name)),
  };
};

export class RegistryStore extends Context.Tag("RegistryStore")<
  RegistryStore,
  RegistryStoreShape
>() {
  static readonly Live = Layer.effect(
    RegistryStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      const readRegistry: Effect.Effect<Registry, RegistryError> = Effect.gen(function* () {
        const exists = yield* fs.exists(paths.registry).pipe(Effect.orElseSucceed(() => false));
        if (!exists) return emptyRegistry;
        const raw = yield* fs.readFileString(paths.registry).pipe(
          Effect.mapError(
            (e) =>
              new RegistryError({
                message: `failed to read ${paths.registry}: ${String(e)}`,
              }),
          ),
        );
        return yield* decodeRegistry(raw).pipe(
          Effect.mapError(
            (e) =>
              new RegistryError({
                message: `registry validation failed: ${e.message}`,
              }),
          ),
        );
      });
      const writeRegistry = (reg: Registry): Effect.Effect<void, RegistryError> =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(paths.registry), { recursive: true }).pipe(
            Effect.mapError(
              (e) =>
                new RegistryError({
                  message: `failed to mkdir for ${paths.registry}: ${String(e)}`,
                }),
            ),
          );
          yield* fs.writeFileString(paths.registry, encodeRegistry(reg)).pipe(
            Effect.mapError(
              (e) =>
                new RegistryError({
                  message: `failed to write ${paths.registry}: ${String(e)}`,
                }),
            ),
          );
        });
      return RegistryStore.of({
        read: readRegistry,
        upsertAgents: (entries) =>
          Effect.gen(function* () {
            const current = yield* readRegistry;
            const next = replaceEntries(current, entries);
            yield* writeRegistry(next);
          }),
        remove: (name) =>
          Effect.gen(function* () {
            const current = yield* readRegistry;
            const next: Registry = {
              ...current,
              agents: current.agents.filter(
                (a) => a.name !== name && !a.name.startsWith(`${name}:`),
              ),
            };
            yield* writeRegistry(next);
          }),
      });
    }),
  );

  static readonly Test = (seed: ReadonlyArray<RegistryEntry> = []) =>
    Layer.effect(
      RegistryStore,
      Effect.gen(function* () {
        const store = yield* Ref.make<Registry>({
          ...emptyRegistry,
          agents: [...seed],
        });
        return RegistryStore.of({
          read: Ref.get(store),
          upsertAgents: (entries) => Ref.update(store, (reg) => replaceEntries(reg, entries)),
          remove: (name) =>
            Ref.update(store, (reg) => ({
              ...reg,
              agents: reg.agents.filter((a) => a.name !== name && !a.name.startsWith(`${name}:`)),
            })),
        });
      }),
    );
}
