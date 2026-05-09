import { Args, Command, Options } from "@effect/cli";
import {
  buildFailureEnvelope,
  buildSuccessEnvelope,
  codeForResult,
  EphemeralRunner,
  type InvokeOptions,
} from "@pihub/core";
import { Console, Effect, Option } from "effect";

const sourceArg = Args.text({ name: "source" }).pipe(
  Args.withDescription(
    "Source URL or local path: github:owner/repo[@ref], https://github.com/owner/repo[@ref], npm:[@scope/]pkg[@version], or a local path. Run is ephemeral — never persists into the registry.",
  ),
);

const taskArg = Args.text({ name: "task" }).pipe(
  Args.optional,
  Args.withDescription("Task prompt (omit to read from stdin)"),
);

const streamFlag = Options.boolean("stream").pipe(
  Options.withDescription("Pass through the raw `pi --mode json` JSONL event stream"),
);

const envelopeFlag = Options.boolean("envelope").pipe(
  Options.withDescription("Emit a single JSON envelope (success or failure) at the end"),
);

const cwdOption = Options.text("cwd").pipe(
  Options.optional,
  Options.withDescription("Override the cwd handed to pi"),
);

const sandboxFlag = Options.boolean("sandbox").pipe(
  Options.withDescription("Spawn pi in a fresh tempdir; remove it on exit"),
);

const timeoutOption = Options.integer("timeout").pipe(
  Options.optional,
  Options.withDescription("Hard timeout in seconds"),
);

const readStdin = (): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () => new Response(Bun.stdin.stream()).text(),
    catch: () => new Error("failed to read stdin"),
  }).pipe(
    Effect.map((s) => s.trim()),
    Effect.catchAll(() => Effect.succeed("")),
  );

export const runCommand = Command.make(
  "run",
  {
    source: sourceArg,
    task: taskArg,
    stream: streamFlag,
    envelope: envelopeFlag,
    cwd: cwdOption,
    sandbox: sandboxFlag,
    timeout: timeoutOption,
  },
  ({ source, task, stream, envelope, cwd, sandbox, timeout }) =>
    Effect.gen(function* () {
      const runner = yield* EphemeralRunner;
      const taskText = task._tag === "Some" ? task.value : yield* readStdin();
      if (taskText.length === 0) {
        yield* Console.error("pihub run: task is empty (pass as arg or pipe via stdin)");
        process.exitCode = 2;
        return;
      }

      const ac = new AbortController();
      const onSigint = () => ac.abort();
      process.on("SIGINT", onSigint);

      const opts: InvokeOptions = { signal: ac.signal };
      if (Option.isSome(cwd)) (opts as { cwd: string }).cwd = cwd.value;
      if (sandbox) (opts as { sandbox: boolean }).sandbox = true;
      if (Option.isSome(timeout)) {
        (opts as { timeoutSeconds: number }).timeoutSeconds = timeout.value;
      }

      const result = yield* runner.run(source, taskText, opts).pipe(
        Effect.catchTag("InvokeInvalidArgsError", (e) =>
          Effect.gen(function* () {
            yield* Console.error(`pihub run: ${e.message}`);
            process.exitCode = 2;
            return null;
          }),
        ),
        Effect.catchTag("InvokeCwdNotFoundError", (e) =>
          Effect.gen(function* () {
            yield* Console.error(`pihub run: ${e.message}`);
            process.exitCode = 2;
            return null;
          }),
        ),
        Effect.ensuring(Effect.sync(() => process.removeListener("SIGINT", onSigint))),
      );
      if (result === null) return;

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
    "Ephemeral install + invoke + cleanup. Never persists to registry/lockfile.",
  ),
);
