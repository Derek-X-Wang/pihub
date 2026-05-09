import { AgentDescription, buildAgentDescription } from "@pihub/schema";
import { Context, Effect, Layer, Option } from "effect";
import { AgentNotFoundError, LockfileError, RegistryError } from "../errors.js";
import { LockfileStore } from "./lockfile-store.js";
import { RegistryStore } from "./registry-store.js";

export type DescribeError = AgentNotFoundError | RegistryError | LockfileError;

export interface DescribeShape {
  readonly describe: (name: string) => Effect.Effect<AgentDescription, DescribeError>;
}

/**
 * Map a canonical agent name to the lockfile key. For shape-β sub-agents the
 * canonical name is `<agentRoot>:<sub>`; the lockfile lives at `<agentRoot>`.
 */
const lockfileKey = (canonicalName: string): string => {
  const colon = canonicalName.indexOf(":");
  return colon === -1 ? canonicalName : canonicalName.slice(0, colon);
};

export class Describe extends Context.Tag("Describe")<Describe, DescribeShape>() {
  static readonly Live = Layer.effect(
    Describe,
    Effect.gen(function* () {
      const registry = yield* RegistryStore;
      const lockStore = yield* LockfileStore;
      return Describe.of({
        describe: (name) =>
          Effect.gen(function* () {
            const reg = yield* registry.read;
            const entry = reg.agents.find((a) => a.name === name);
            if (!entry) {
              return yield* Effect.fail(
                new AgentNotFoundError({
                  name,
                  message: `no agent named ${name} — run \`pihub list\` to see installed agents`,
                }),
              );
            }
            const lock = yield* lockStore.read(lockfileKey(name));
            if (Option.isNone(lock)) {
              return yield* Effect.fail(
                new AgentNotFoundError({
                  name,
                  message: `registry has ${name} but its install lockfile is missing — re-run \`pihub install\``,
                }),
              );
            }
            return buildAgentDescription(entry, lock.value);
          }),
      });
    }),
  );
}
