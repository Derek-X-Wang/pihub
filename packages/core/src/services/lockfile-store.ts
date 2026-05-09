import { FileSystem } from "@effect/platform";
import { Lockfile } from "@pihub/schema";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import * as path from "node:path";
import { LockfileError } from "../errors.js";
import { Paths } from "../paths.js";

const decodeLockfile = Schema.decodeUnknown(Schema.parseJson(Lockfile));
const encodeLockfile = (lock: Lockfile) => JSON.stringify(lock, null, 2) + "\n";

export interface LockfileStoreShape {
  readonly read: (agentName: string) => Effect.Effect<Option.Option<Lockfile>, LockfileError>;
  readonly write: (agentName: string, lock: Lockfile) => Effect.Effect<void, LockfileError>;
}

export class LockfileStore extends Context.Tag("LockfileStore")<
  LockfileStore,
  LockfileStoreShape
>() {
  static readonly Live = Layer.effect(
    LockfileStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      return LockfileStore.of({
        read: (agentName) =>
          Effect.gen(function* () {
            const lockPath = paths.agentLockfile(agentName);
            const exists = yield* fs.exists(lockPath).pipe(Effect.orElseSucceed(() => false));
            if (!exists) return Option.none<Lockfile>();
            const raw = yield* fs.readFileString(lockPath).pipe(
              Effect.mapError(
                (e) =>
                  new LockfileError({
                    message: `failed to read ${lockPath}: ${String(e)}`,
                  }),
              ),
            );
            const decoded = yield* decodeLockfile(raw).pipe(
              Effect.mapError(
                (e) =>
                  new LockfileError({
                    message: `lockfile validation failed at ${lockPath}: ${e.message}`,
                  }),
              ),
            );
            return Option.some(decoded);
          }),
        write: (agentName, lock) =>
          Effect.gen(function* () {
            const lockPath = paths.agentLockfile(agentName);
            yield* fs.makeDirectory(path.dirname(lockPath), { recursive: true }).pipe(
              Effect.mapError(
                (e) =>
                  new LockfileError({
                    message: `failed to mkdir for ${lockPath}: ${String(e)}`,
                  }),
              ),
            );
            yield* fs.writeFileString(lockPath, encodeLockfile(lock)).pipe(
              Effect.mapError(
                (e) =>
                  new LockfileError({
                    message: `failed to write ${lockPath}: ${String(e)}`,
                  }),
              ),
            );
          }),
      });
    }),
  );

  static readonly Test = (seed: ReadonlyMap<string, Lockfile> = new Map()) =>
    Layer.effect(
      LockfileStore,
      Effect.gen(function* () {
        const store = yield* Ref.make(new Map(seed));
        return LockfileStore.of({
          read: (agentName) =>
            Ref.get(store).pipe(Effect.map((m) => Option.fromNullable(m.get(agentName)))),
          write: (agentName, lock) => Ref.update(store, (m) => new Map([...m, [agentName, lock]])),
        });
      }),
    );
}
