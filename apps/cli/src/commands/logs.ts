import { Args, Command, Options } from "@effect/cli";
import { DEFAULT_LOG_RETENTION, LogStore } from "@pihub/core";
import { Console, Effect, Option } from "effect";

const agentArg = Args.text({ name: "agent" }).pipe(
  Args.withDescription("Canonical agent name to query logs for"),
);

const limitOption = Options.integer("limit").pipe(
  Options.optional,
  Options.withDescription("Maximum number of invocations to list (default: 50)"),
);

const sinceOption = Options.text("since").pipe(
  Options.optional,
  Options.withDescription("ISO timestamp lower bound; only invocations >= this are listed"),
);

const invocationIdOption = Options.text("invocation-id").pipe(
  Options.optional,
  Options.withDescription("Dump the full JSONL events for this invocation instead of listing"),
);

export const logsCommand = Command.make(
  "logs",
  { agent: agentArg, limit: limitOption, since: sinceOption, invocationId: invocationIdOption },
  ({ agent, limit, since, invocationId }) =>
    Effect.gen(function* () {
      const store = yield* LogStore;
      if (Option.isSome(invocationId)) {
        const result = yield* store.readEvents(invocationId.value).pipe(
          Effect.catchTag("LogNotFoundError", (e) =>
            Effect.gen(function* () {
              yield* Console.error(`pihub logs: ${e.message}`);
              process.exitCode = 2;
              return null;
            }),
          ),
        );
        if (result === null) return;
        process.stdout.write(result);
        return;
      }

      const opts: { limit?: number; since?: string } = {};
      opts.limit = Option.match(limit, {
        onNone: () => DEFAULT_LOG_RETENTION,
        onSome: (n) => n,
      });
      if (Option.isSome(since)) opts.since = since.value;

      const list = yield* store.listForAgent(agent, opts);
      if (list.length === 0) {
        yield* Console.log(`(no logs for ${agent})`);
        return;
      }
      const idWidth = Math.max(8, ...list.map((m) => m.invocationId.length));
      const tsWidth = 24;
      yield* Console.log(
        `${"INVOCATION-ID".padEnd(idWidth)}  ${"STARTED-AT".padEnd(tsWidth)}  EXIT  DURATION  PROMPT`,
      );
      for (const m of list) {
        yield* Console.log(
          `${m.invocationId.padEnd(idWidth)}  ${m.startedAt.padEnd(tsWidth)}  ${String(
            m.exitCode,
          ).padStart(4)}  ${`${m.durationMs}ms`.padStart(8)}  ${m.firstPromptLine}`,
        );
      }
    }),
).pipe(Command.withDescription("List recent invocations for an agent (or dump one's events)"));
