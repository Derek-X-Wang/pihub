import { Args, Command } from "@effect/cli";
import { Remover } from "@pihub/core";
import { Console, Effect } from "effect";

const nameArg = Args.text({ name: "agent" }).pipe(
  Args.withDescription("Canonical agent name (or alias) to remove"),
);

export const removeCommand = Command.make("remove", { name: nameArg }, ({ name }) =>
  Effect.gen(function* () {
    const remover = yield* Remover;
    const result = yield* remover.remove(name).pipe(
      Effect.catchTag("AgentNotFoundError", (e) =>
        Effect.gen(function* () {
          yield* Console.error(`pihub remove: ${e.message}`);
          process.exitCode = 2;
          return null;
        }),
      ),
    );
    if (result === null) return;
    yield* Console.log(`removed ${result.agentRoot}`);
    if (result.removedEntries.length > 1 || result.removedEntries[0] !== result.agentRoot) {
      for (const entry of result.removedEntries) {
        yield* Console.log(`  registry: ${entry}`);
      }
    }
    if (result.removedAliases.length > 0) {
      for (const a of result.removedAliases) {
        yield* Console.log(`  alias:    ${a}`);
      }
    }
    yield* Console.log(`  logs:     ${result.removedLogs} invocation(s) deleted`);
  }),
).pipe(
  Command.withDescription(
    "Uninstall an agent — removes its dir, lockfile, env, logs, registry entries, and aliases",
  ),
);
