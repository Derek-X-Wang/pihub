import { FileSystem } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import { AgentNotFoundError, AliasStoreError, LogStoreError, RegistryError } from "../errors.js";
import { Paths } from "../paths.js";
import { AliasStore } from "./alias-store.js";
import { LogStore } from "./log-store.js";
import { RegistryStore } from "./registry-store.js";

export interface RemoveResult {
  readonly agentRoot: string;
  /** Names that were dropped from the registry. */
  readonly removedEntries: ReadonlyArray<string>;
  /** Aliases that were dropped because they pointed at this agent. */
  readonly removedAliases: ReadonlyArray<string>;
  /** Number of log files deleted. */
  readonly removedLogs: number;
}

export type RemoverError = AgentNotFoundError | RegistryError | AliasStoreError | LogStoreError;

export interface RemoverShape {
  readonly remove: (name: string) => Effect.Effect<RemoveResult, RemoverError>;
}

const agentRootOf = (canonical: string): string => {
  const colon = canonical.indexOf(":");
  return colon === -1 ? canonical : canonical.slice(0, colon);
};

export class Remover extends Context.Tag("Remover")<Remover, RemoverShape>() {
  static readonly Live = Layer.effect(
    Remover,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      const registry = yield* RegistryStore;
      const aliasStore = yield* AliasStore;
      const logStore = yield* LogStore;
      return {
        remove: (name) =>
          Effect.gen(function* () {
            // Resolve the agent root from the supplied name. Accept canonical
            // (`<owner>/<repo>` or `<owner>/<repo>:<sub>`) or an alias.
            const canonical = yield* aliasStore.resolve(name);
            const root = agentRootOf(canonical);

            const reg = yield* registry.read;
            const matching = reg.agents.filter(
              (a) => a.name === root || a.name.startsWith(`${root}:`),
            );
            if (matching.length === 0) {
              return yield* Effect.fail(
                new AgentNotFoundError({
                  name,
                  message: `no agent installed under '${root}' — run \`pihub list\` to see installed agents`,
                }),
              );
            }

            // Wipe the agent's on-disk state. Best-effort: missing dirs are
            // not an error (idempotent re-removal).
            yield* fs
              .remove(paths.agentRoot(root), { recursive: true, force: true })
              .pipe(Effect.catchAll(() => Effect.void));

            // Drop log files attributed to any sub-agent name. β agents have
            // multiple per-sub registry entries, but logs are keyed by the
            // canonical name the Invoker used at spawn time — that's the
            // sub-agent name. So iterate matching entries and remove each.
            let removedLogs = 0;
            for (const entry of matching) {
              removedLogs += yield* logStore.removeForAgent(entry.name);
            }

            // Drop aliases pointing at this agent root or any sub-agent.
            const removedAliases = yield* aliasStore.removeForCanonical(root);

            // Drop the registry entries last so the recovery story (e.g.
            // re-running on partial-failure) re-finds the agent on retry.
            for (const entry of matching) {
              yield* registry.remove(entry.name);
            }

            return {
              agentRoot: root,
              removedEntries: matching.map((m) => m.name),
              removedAliases,
              removedLogs,
            } satisfies RemoveResult;
          }),
      } satisfies RemoverShape;
    }),
  );
}
