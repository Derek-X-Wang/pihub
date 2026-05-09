import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer, Ref } from "effect";
import * as path from "node:path";
import { RuntimeSlotError } from "../errors.js";
import { Paths } from "../paths.js";
import { BunInstaller } from "./bun-installer.js";

const SLOT_PACKAGE_JSON = `${JSON.stringify(
  { name: "pihub-pi-slot", private: true, version: "0.0.0", type: "module" },
  null,
  2,
)}\n`;

const piDepFor = (minor: string): string => `@mariozechner/pi-coding-agent@~${minor}.0`;

export interface RuntimeSlotManagerShape {
  /**
   * Ensure `~/.pihub/runtime/pi/<minor>/` is populated and return the absolute
   * path of the `pi` binary inside it. Idempotent: returns the cached path
   * when the binary is already installed.
   */
  readonly ensureSlot: (minor: string) => Effect.Effect<string, RuntimeSlotError>;
}

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
      return {
        ensureSlot: (minor) =>
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
          }),
      } satisfies RuntimeSlotManagerShape;
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
        } satisfies RuntimeSlotManagerShape;
      }),
    );
}
