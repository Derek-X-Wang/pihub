import { Args, Command } from "@effect/cli";
import { Installer } from "@pihub/core";
import { Console, Effect } from "effect";

const sourceArg = Args.text({ name: "source" }).pipe(
  Args.withDescription("Local path or source URL of the agent (slice #3 supports local only)"),
);

export const installCommand = Command.make("install", { source: sourceArg }, ({ source }) =>
  Effect.gen(function* () {
    const installer = yield* Installer;
    const result = yield* installer.install(source);
    if (result.cached) {
      yield* Console.log(`already installed: ${result.agentRoot} (idempotent re-install)`);
    } else {
      yield* Console.log(`installed: ${result.agentRoot}`);
    }
    for (const entry of result.entries) {
      yield* Console.log(`  - ${entry.name}  ${entry.description}`);
    }
  }),
).pipe(Command.withDescription("Install an agent from a local path"));
