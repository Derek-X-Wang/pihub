import { Command, Options } from "@effect/cli";
import { DEFAULT_LOG_RETENTION, LogStore } from "@pihub/core";
import { Console, Effect, Option } from "effect";

const retentionOption = Options.integer("retention").pipe(
  Options.optional,
  Options.withDescription(
    `Per-agent retention to apply (default: ${DEFAULT_LOG_RETENTION}). Slice #21 will read this from \`pihub config get logs.retention\`.`,
  ),
);

export const gcLogsCommand = Command.make(
  "gc-logs",
  { retention: retentionOption },
  ({ retention }) =>
    Effect.gen(function* () {
      const store = yield* LogStore;
      const r = Option.match(retention, {
        onNone: () => DEFAULT_LOG_RETENTION,
        onSome: (n) => n,
      });
      const results = yield* store.pruneAll(r);
      if (results.length === 0) {
        yield* Console.log("(no logs on disk)");
        return;
      }
      let total = 0;
      for (const { agent, deleted } of results) {
        if (deleted > 0) yield* Console.log(`${agent}: deleted ${deleted}`);
        total += deleted;
      }
      yield* Console.log(`total deleted: ${total} (retention=${r})`);
    }),
).pipe(Command.withDescription("Prune log files across all agents back to a retention limit"));
