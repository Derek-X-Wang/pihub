import { Args, Command } from "@effect/cli";
import { Invoker } from "@pihub/core";
import { Console, Effect } from "effect";

const nameArg = Args.text({ name: "agent" }).pipe(
  Args.withDescription("Canonical agent name (e.g. `sample-beta-agent:scout`)"),
);

const taskArg = Args.text({ name: "task" }).pipe(
  Args.optional,
  Args.withDescription("Task prompt (omit to read from stdin)"),
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
  { name: nameArg, task: taskArg },
  ({ name, task }) =>
    Effect.gen(function* () {
      const invoker = yield* Invoker;
      const taskText = task._tag === "Some" ? task.value : yield* readStdin();
      if (taskText.length === 0) {
        yield* Console.error("pihub invoke: task is empty (pass as arg or pipe via stdin)");
        process.exitCode = 2;
        return;
      }
      const result = yield* invoker.invoke(name, taskText);
      if (result.exitCode !== 0) {
        if (result.text.length > 0) yield* Console.error(result.text);
        process.exitCode = 1;
        return;
      }
      yield* Console.log(result.text);
    }),
).pipe(
  Command.withDescription("Invoke an installed agent — prints the assistant's final text response"),
);
