import { Args, Command, Options } from "@effect/cli";
import {
  buildFailureEnvelope,
  buildSuccessEnvelope,
  codeForResult,
  Invoker,
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

const timeoutOption = Options.integer("timeout").pipe(
  Options.optional,
  Options.withDescription(
    "Hard timeout in seconds (precedence: flag > manifest.timeoutSeconds > 600s)",
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
  {
    name: nameArg,
    task: taskArg,
    stream: streamFlag,
    envelope: envelopeFlag,
    cwd: cwdOption,
    sandbox: sandboxFlag,
    timeout: timeoutOption,
  },
  ({ name, task, stream, envelope, cwd, sandbox, timeout }) =>
    Effect.gen(function* () {
      const invoker = yield* Invoker;
      const taskText = task._tag === "Some" ? task.value : yield* readStdin();
      if (taskText.length === 0) {
        yield* Console.error("pihub invoke: task is empty (pass as arg or pipe via stdin)");
        process.exitCode = 2;
        return;
      }

      // Wire SIGINT → AbortController so Ctrl-C from the caller forwards to pi
      // through the same termination logic that timeout uses. The handler is
      // removed in `finally` so re-runs don't accumulate listeners.
      const ac = new AbortController();
      const onSigint = () => ac.abort();
      process.on("SIGINT", onSigint);

      const invokeOpts: InvokeOptions = { signal: ac.signal };
      if (Option.isSome(cwd)) (invokeOpts as { cwd: string }).cwd = cwd.value;
      if (sandbox) (invokeOpts as { sandbox: boolean }).sandbox = true;
      if (Option.isSome(timeout)) {
        (invokeOpts as { timeoutSeconds: number }).timeoutSeconds = timeout.value;
      }

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
        Effect.ensuring(Effect.sync(() => process.removeListener("SIGINT", onSigint))),
      );
      if (result === null) return;

      // Map exit codes per CONTEXT.md: 124 timeout, 130 abort, 1 generic failure.
      const setExit = () => {
        if (result.exitCode === 0) return;
        if (result.terminationReason === "timeout") process.exitCode = 124;
        else if (result.terminationReason === "abort") process.exitCode = 130;
        else process.exitCode = 1;
      };

      if (envelope) {
        if (stream) process.stderr.write(result.raw);
        const env =
          result.exitCode === 0
            ? buildSuccessEnvelope(result)
            : buildFailureEnvelope(result, codeForResult(result));
        yield* Console.log(JSON.stringify(env));
        setExit();
        return;
      }

      if (stream) {
        process.stdout.write(result.raw);
      }
      if (result.exitCode !== 0) {
        if (!stream && result.stderr.length > 0) yield* Console.error(result.stderr.trim());
        setExit();
        return;
      }
      if (!stream) yield* Console.log(result.text);
    }),
).pipe(
  Command.withDescription(
    "Invoke an installed agent — default text, --stream JSONL, --envelope aggregated JSON",
  ),
);
