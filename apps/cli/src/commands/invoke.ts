import { Args, Command, Options } from "@effect/cli";
import {
  buildFailureEnvelope,
  buildSuccessEnvelope,
  Invoker,
  mapStopReasonToCode,
  type InvokeOptions,
} from "@pihub/core";
import { Console, Effect, Option } from "effect";

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

const cwdOption = Options.text("cwd").pipe(
  Options.optional,
  Options.withDescription("Override the cwd handed to pi (defaults to caller's cwd)"),
);

const sandboxFlag = Options.boolean("sandbox").pipe(
  Options.withDescription("Spawn pi in a fresh tempdir; remove it on exit"),
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
  {
    name: nameArg,
    task: taskArg,
    stream: streamFlag,
    envelope: envelopeFlag,
    cwd: cwdOption,
    sandbox: sandboxFlag,
  },
  ({ name, task, stream, envelope, cwd, sandbox }) =>
    Effect.gen(function* () {
      const invoker = yield* Invoker;
      const taskText = task._tag === "Some" ? task.value : yield* readStdin();
      if (taskText.length === 0) {
        yield* Console.error("pihub invoke: task is empty (pass as arg or pipe via stdin)");
        process.exitCode = 2;
        return;
      }
      const invokeOpts: InvokeOptions = {};
      if (Option.isSome(cwd)) (invokeOpts as { cwd: string }).cwd = cwd.value;
      if (sandbox) (invokeOpts as { sandbox: boolean }).sandbox = true;

      const result = yield* invoker.invoke(name, taskText, invokeOpts).pipe(
        Effect.catchTag("InvokeInvalidArgsError", (e) =>
          Effect.gen(function* () {
            yield* Console.error(`pihub invoke: ${e.message}`);
            process.exitCode = 2;
            return null;
          }),
        ),
        Effect.catchTag("InvokeCwdNotFoundError", (e) =>
          Effect.gen(function* () {
            yield* Console.error(`pihub invoke: ${e.message}`);
            process.exitCode = 2;
            return null;
          }),
        ),
      );
      if (result === null) return;

      if (envelope) {
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
