import { Context, Effect, Layer, Ref } from "effect";
import { BunInstallError } from "../errors.js";

export interface BunInstallerShape {
  /**
   * Run `bun install <dep>` in `cwd`. The slot dir must already contain a
   * minimal `package.json`. Live shells out via `Bun.spawn`; Test records the
   * call without spawning.
   */
  readonly install: (cwd: string, dep: string) => Effect.Effect<void, BunInstallError>;
}

export class BunInstaller extends Context.Tag("BunInstaller")<BunInstaller, BunInstallerShape>() {
  static readonly Live = Layer.succeed(BunInstaller, {
    install: (cwd, dep) =>
      Effect.tryPromise({
        try: async () => {
          const proc = Bun.spawn(["bun", "install", "--silent", dep], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
          });
          const stderr = await new Response(proc.stderr).text();
          const code = await proc.exited;
          if (code !== 0) {
            throw new Error(`bun install ${dep} exited ${code}: ${stderr.trim()}`);
          }
        },
        catch: (e) => new BunInstallError({ cwd, dep, message: String(e) }),
      }),
  });

  static readonly Test = () =>
    Layer.effect(
      BunInstaller,
      Effect.gen(function* () {
        const calls = yield* Ref.make<Array<{ cwd: string; dep: string }>>([]);
        return {
          install: (cwd, dep) => Ref.update(calls, (xs) => [...xs, { cwd, dep }]),
        } satisfies BunInstallerShape;
      }),
    );
}
