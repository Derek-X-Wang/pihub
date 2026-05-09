import { Context, Effect, Layer } from "effect";
import { EnvFileError } from "../errors.js";
import { Paths } from "../paths.js";
import { EnvStore } from "./env-store.js";

export interface EnvResolverShape {
  /**
   * Build the env that gets passed to `pi`. Layered (highest wins):
   *   1. caller shell `process.env`
   *   2. per-agent `~/.pihub/agents/<name>/env`
   *   3. global `~/.pihub/env`
   *
   * If `allowlist` is non-undefined, the result is filtered to only the keys
   * present in it. `undefined` (manifest didn't declare `env`) → all keys
   * pass through.
   */
  readonly resolve: (
    agentName: string,
    allowlist: ReadonlyArray<string> | undefined,
  ) => Effect.Effect<Record<string, string>, EnvFileError>;
}

const filterByAllowlist = (
  env: Record<string, string>,
  allowlist: ReadonlyArray<string> | undefined,
): Record<string, string> => {
  if (!allowlist) return env;
  const set = new Set(allowlist);
  const out: Record<string, string> = {};
  for (const key of Object.keys(env)) {
    if (set.has(key)) out[key] = env[key] as string;
  }
  return out;
};

const processEnvAsRecord = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
};

export class EnvResolver extends Context.Tag("EnvResolver")<EnvResolver, EnvResolverShape>() {
  static readonly Live = Layer.effect(
    EnvResolver,
    Effect.gen(function* () {
      const paths = yield* Paths;
      const store = yield* EnvStore;
      return {
        resolve: (agentName, allowlist) =>
          Effect.gen(function* () {
            const global = yield* store.read(paths.globalEnv);
            const agent = yield* store.read(paths.agentEnv(agentName));
            const merged: Record<string, string> = {
              ...global,
              ...agent,
              ...processEnvAsRecord(),
            };
            return filterByAllowlist(merged, allowlist);
          }),
      } satisfies EnvResolverShape;
    }),
  );

  /** Test layer: returns a canned Map keyed by agent name. */
  static readonly Test = (seed: ReadonlyMap<string, Record<string, string>> = new Map()) =>
    Layer.succeed(EnvResolver, {
      resolve: (agentName, allowlist) => {
        const env = seed.get(agentName) ?? {};
        return Effect.succeed(filterByAllowlist({ ...env }, allowlist));
      },
    });
}
