import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Ref } from "effect";
import * as path from "node:path";
import { RuntimeSlotError } from "../errors.js";
import { Paths } from "../paths.js";
import { BunInstaller } from "./bun-installer.js";
import { RegistryStore } from "./registry-store.js";

const SLOT_PACKAGE_JSON = `${JSON.stringify(
  { name: "pihub-pi-slot", private: true, version: "0.0.0", type: "module" },
  null,
  2,
)}\n`;

const piDepFor = (minor: string): string => `@mariozechner/pi-coding-agent@~${minor}.0`;

export interface SlotInfo {
  readonly minor: string;
  readonly path: string;
  readonly refcount: number;
  readonly bytes: number;
}

export interface RuntimeSlotManagerShape {
  /**
   * Ensure `~/.pihub/runtime/pi/<minor>/` is populated and return the absolute
   * path of the `pi` binary inside it. Idempotent: returns the cached path
   * when the binary is already installed.
   */
  readonly ensureSlot: (minor: string) => Effect.Effect<string, RuntimeSlotError>;
  /**
   * Enumerate every slot dir under `~/.pihub/runtime/pi/`, with refcount
   * (derived from registry entries) and on-disk size in bytes.
   */
  readonly listSlots: Effect.Effect<ReadonlyArray<SlotInfo>, RuntimeSlotError>;
  /**
   * Remove a slot. Fails with `RuntimeSlotError` when refcount > 0 so callers
   * can map to exit 2.
   */
  readonly removeSlot: (minor: string) => Effect.Effect<void, RuntimeSlotError>;
  /**
   * Remove all slots whose refcount is 0. Returns the minors deleted.
   */
  readonly gc: Effect.Effect<ReadonlyArray<string>, RuntimeSlotError>;
}

const dirSizeOf = (
  fs: FileSystem.FileSystem,
  root: string,
): Effect.Effect<number, RuntimeSlotError> =>
  Effect.gen(function* () {
    const stat = yield* fs.stat(root).pipe(Effect.catchAll(() => Effect.succeed(null as never)));
    if (stat === null) return 0;
    if (stat.type !== "Directory") return Number(stat.size);
    let total = 0;
    const entries = yield* fs
      .readDirectory(root)
      .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)));
    for (const entry of entries) {
      total += yield* dirSizeOf(fs, path.join(root, entry));
    }
    return total;
  });

export class RuntimeSlotManager extends Context.Tag("RuntimeSlotManager")<
  RuntimeSlotManager,
  RuntimeSlotManagerShape
>() {
  static readonly Live = Layer.effect(
    RuntimeSlotManager,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      const installer = yield* BunInstaller;
      const registry = yield* RegistryStore;

      const refcountFor = (minor: string) =>
        registry.read.pipe(
          Effect.map((reg) => reg.agents.filter((a) => a.piSlot === minor).length),
          Effect.mapError(
            (e) =>
              new RuntimeSlotError({
                slot: minor,
                message: `failed to read registry for refcount: ${e.message}`,
              }),
          ),
        );

      const ensureSlot = (minor: string) =>
        Effect.gen(function* () {
          const slotDir = paths.runtimeSlot(minor);
          const binPath = path.join(slotDir, "node_modules", ".bin", "pi");
          const cached = yield* fs.exists(binPath).pipe(Effect.orElseSucceed(() => false));
          if (cached) return binPath;

          yield* fs.makeDirectory(slotDir, { recursive: true }).pipe(
            Effect.mapError(
              (e) =>
                new RuntimeSlotError({
                  slot: minor,
                  message: `failed to mkdir ${slotDir}: ${String(e)}`,
                }),
            ),
          );
          yield* fs.writeFileString(path.join(slotDir, "package.json"), SLOT_PACKAGE_JSON).pipe(
            Effect.mapError(
              (e) =>
                new RuntimeSlotError({
                  slot: minor,
                  message: `failed to seed package.json in ${slotDir}: ${String(e)}`,
                }),
            ),
          );
          yield* installer.install(slotDir, piDepFor(minor)).pipe(
            Effect.mapError(
              (e) =>
                new RuntimeSlotError({
                  slot: minor,
                  message: `bun install failed for ${minor}: ${e.message}`,
                }),
            ),
          );
          const installed = yield* fs.exists(binPath).pipe(Effect.orElseSucceed(() => false));
          if (!installed) {
            return yield* Effect.fail(
              new RuntimeSlotError({
                slot: minor,
                message: `bun install completed but no binary at ${binPath}`,
              }),
            );
          }
          return binPath;
        });

      const listSlots: Effect.Effect<ReadonlyArray<SlotInfo>, RuntimeSlotError> = Effect.gen(
        function* () {
          const root = path.dirname(paths.runtimeSlot("0"));
          const exists = yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false));
          if (!exists) return [];
          const minors = yield* fs.readDirectory(root).pipe(
            Effect.mapError(
              (e) =>
                new RuntimeSlotError({
                  slot: "*",
                  message: `failed to readDirectory ${root}: ${String(e)}`,
                }),
            ),
          );
          const sorted = [...minors].sort();
          const reg = yield* registry.read.pipe(
            Effect.mapError(
              (e) =>
                new RuntimeSlotError({
                  slot: "*",
                  message: `failed to read registry: ${e.message}`,
                }),
            ),
          );
          const out: Array<SlotInfo> = [];
          for (const minor of sorted) {
            const slotDir = paths.runtimeSlot(minor);
            const stat = yield* fs
              .stat(slotDir)
              .pipe(Effect.catchAll(() => Effect.succeed(null as never)));
            if (stat === null || stat.type !== "Directory") continue;
            const refcount = reg.agents.filter((a) => a.piSlot === minor).length;
            const bytes = yield* dirSizeOf(fs, slotDir);
            out.push({ minor, path: slotDir, refcount, bytes });
          }
          return out;
        },
      );

      const removeSlot = (minor: string) =>
        Effect.gen(function* () {
          const refs = yield* refcountFor(minor);
          if (refs > 0) {
            return yield* Effect.fail(
              new RuntimeSlotError({
                slot: minor,
                message: `cannot remove slot ${minor}: ${refs} agent(s) pin it (run \`pihub list\` to see them)`,
              }),
            );
          }
          const slotDir = paths.runtimeSlot(minor);
          yield* fs.remove(slotDir, { recursive: true, force: true }).pipe(
            Effect.mapError(
              (e) =>
                new RuntimeSlotError({
                  slot: minor,
                  message: `failed to remove ${slotDir}: ${String(e)}`,
                }),
            ),
          );
        });

      const gc: Effect.Effect<ReadonlyArray<string>, RuntimeSlotError> = Effect.gen(function* () {
        const slots = yield* listSlots;
        const deleted: Array<string> = [];
        for (const s of slots) {
          if (s.refcount === 0) {
            yield* fs.remove(s.path, { recursive: true, force: true }).pipe(
              Effect.mapError(
                (e) =>
                  new RuntimeSlotError({
                    slot: s.minor,
                    message: `failed to remove ${s.path}: ${String(e)}`,
                  }),
              ),
            );
            deleted.push(s.minor);
          }
        }
        return deleted;
      });

      return { ensureSlot, listSlots, removeSlot, gc } satisfies RuntimeSlotManagerShape;
    }),
  );

  /**
   * Test layer: returns the seeded path for any minor. Useful when tests want
   * to point at a faux-pi shell script regardless of the slot label.
   */
  static readonly Test = (seed: ReadonlyMap<string, string> = new Map()) =>
    Layer.effect(
      RuntimeSlotManager,
      Effect.gen(function* () {
        const store = yield* Ref.make(new Map(seed));
        return {
          ensureSlot: (minor) =>
            Effect.gen(function* () {
              const m = yield* Ref.get(store);
              const hit = m.get(minor) ?? m.get("*");
              if (!hit) {
                return yield* Effect.fail(
                  new RuntimeSlotError({
                    slot: minor,
                    message: "no canned binary path for this minor in Test layer",
                  }),
                );
              }
              return hit;
            }),
          listSlots: Ref.get(store).pipe(
            Effect.map((m) =>
              [...m.entries()]
                .filter(([k]) => k !== "*")
                .map(([minor, p]) => ({ minor, path: p, refcount: 0, bytes: 0 })),
            ),
          ),
          removeSlot: (minor) =>
            Ref.update(store, (m) => {
              const next = new Map(m);
              next.delete(minor);
              return next;
            }),
          gc: Ref.get(store).pipe(Effect.map((m) => [...m.keys()].filter((k) => k !== "*"))),
        } satisfies RuntimeSlotManagerShape;
      }),
    );
}
