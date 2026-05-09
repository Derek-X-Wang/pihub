import { Context, Effect, Layer, Ref } from "effect";
import { GitCloneError } from "../errors.js";

export interface GitClientShape {
  /**
   * Clone `url` into `dest` and check out `ref` (tag, branch, or 40-char SHA).
   * Implementations are free to optimise (shallow clone, no checkout, …) so
   * long as `dest` ends up populated and at the requested ref.
   */
  readonly clone: (url: string, dest: string, ref: string) => Effect.Effect<void, GitCloneError>;
}

const runGit = (
  args: ReadonlyArray<string>,
): Effect.Effect<{ stdout: string; stderr: string }, GitCloneError> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["git", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new Error(`git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
      }
      return { stdout, stderr };
    },
    catch: (e) =>
      new GitCloneError({
        url: args.join(" "),
        dest: "",
        message: String(e),
      }),
  });

export class GitClient extends Context.Tag("GitClient")<GitClient, GitClientShape>() {
  static readonly Live = Layer.succeed(GitClient, {
    clone: (url, dest, ref) =>
      Effect.gen(function* () {
        yield* runGit(["clone", "--quiet", url, dest]).pipe(
          Effect.mapError(
            (e) => new GitCloneError({ url, dest, message: `clone failed: ${e.message}` }),
          ),
        );
        yield* runGit(["-C", dest, "checkout", "--quiet", ref]).pipe(
          Effect.mapError(
            (e) =>
              new GitCloneError({ url, dest, message: `checkout ${ref} failed: ${e.message}` }),
          ),
        );
      }),
  });

  /**
   * Test layer that records every clone request without spawning git. Tests
   * can compose this with `Profile.Test` and `LockfileStore.Test` etc. so the
   * full Installer pipeline runs purely in-memory.
   */
  static readonly Test = () =>
    Layer.effect(
      GitClient,
      Effect.gen(function* () {
        const calls = yield* Ref.make<Array<{ url: string; dest: string; ref: string }>>([]);
        return {
          clone: (url, dest, ref) => Ref.update(calls, (xs) => [...xs, { url, dest, ref }]),
        } satisfies GitClientShape;
      }),
    );
}
