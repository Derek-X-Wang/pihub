import { Args, Command, Options } from "@effect/cli";
import {
  buildFailureEnvelope,
  buildSuccessEnvelope,
  Invoker,
  mapStopReasonToCode,
} from "@pihub/core";
import { Console, Effect } from "effect";

const nameArg = Args.text({ name: "agent" }).pipe(
  Args.withDescription("Canonical agent name (e.g. `sample-beta-agent:scout`)"),
);

const taskArg = Args.text({ name: "task" }).pipe(
  Args.optional,
  Args.withDescription("Task prompt (omit to read from stdin)"),
);

const streamFlag = Options.boolean("stream").pipe(
  Options.withDescription(
    "Pass through the raw `pi --mode json` JSONL event stream to stdout instead of the projected final text",
  ),
);

const envelopeFlag = Options.boolean("envelope").pipe(
  Options.withDescription(
    "Emit a single JSON envelope (success or failure) at the end of the invocation",
  ),
);

const readStdin = (): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => new Response(Bun.stdin.stream()).text(),
    catch: () => new Error("failed to read stdin"),
  }).pipe(
    Effect.map((s) => s.trim()),
    Effect.catchAll(() => Effect.succeed("")),
  );

export const invokeCommand = Command.make(
  "invoke",
  { name: nameArg, task: taskArg, stream: streamFlag, envelope: envelopeFlag },
  ({ name, task, stream, envelope }) =>
    Effect.gen(function* () {
      const invoker = yield* Invoker;
      const taskText = task._tag === "Some" ? task.value : yield* readStdin();
      if (taskText.length === 0) {
        yield* Console.error("pihub invoke: task is empty (pass as arg or pipe via stdin)");
        process.exitCode = 2;
        return;
      }
      const result = yield* invoker.invoke(name, taskText);

      if (envelope) {
        // Stream + envelope can coexist: stream first, envelope last on stderr
        // would collide with normal stderr usage. Rule: --envelope wins on
        // stdout. If --stream is also set, the raw JSONL goes to stderr so
        // both channels are still consumable.
        if (stream) process.stderr.write(result.raw);
        const env =
          result.exitCode === 0
            ? buildSuccessEnvelope(result)
            : buildFailureEnvelope(
                result,
                mapStopReasonToCode(result.stopReason, result.errorMessage),
              );
        yield* Console.log(JSON.stringify(env));
        if (result.exitCode !== 0) process.exitCode = 1;
        return;
      }

      if (stream) {
        // Emit the raw JSONL stream verbatim, regardless of exit code.
        process.stdout.write(result.raw);
      }
      if (result.exitCode !== 0) {
        if (!stream && result.stderr.length > 0) yield* Console.error(result.stderr.trim());
        process.exitCode = 1;
        return;
      }
      if (!stream) yield* Console.log(result.text);
    }),
).pipe(
  Command.withDescription(
    "Invoke an installed agent — default text, --stream JSONL, --envelope aggregated JSON",
  ),
);
