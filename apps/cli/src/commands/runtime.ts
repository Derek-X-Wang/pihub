import { Args, Command, Options } from "@effect/cli";
import { RuntimeSlotManager } from "@pihub/core";
import { Console, Effect } from "effect";

const minorArg = Args.text({ name: "minor" }).pipe(
  Args.withDescription("Pi minor version (e.g. 0.74)"),
);

const jsonFlag = Options.boolean("json").pipe(
  Options.withDescription("Emit slots as JSON instead of a table"),
);

const formatBytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}K`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)}M`;
  return `${(mb / 1024).toFixed(2)}G`;
};

const listSubcommand = Command.make("list", { json: jsonFlag }, ({ json }) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeSlotManager;
    const slots = yield* runtime.listSlots;
    if (json) {
      yield* Console.log(JSON.stringify(slots, null, 2));
      return;
    }
    if (slots.length === 0) {
      yield* Console.log("(no Pi runtime slots installed)");
      return;
    }
    const minorWidth = Math.max(5, ...slots.map((s) => s.minor.length));
    const sizeWidth = Math.max(6, ...slots.map((s) => formatBytes(s.bytes).length));
    yield* Console.log(
      `${"MINOR".padEnd(minorWidth)}  ${"REFCOUNT".padStart(8)}  ${"SIZE".padStart(sizeWidth)}  PATH`,
    );
    for (const s of slots) {
      yield* Console.log(
        `${s.minor.padEnd(minorWidth)}  ${String(s.refcount).padStart(8)}  ${formatBytes(s.bytes).padStart(sizeWidth)}  ${s.path}`,
      );
    }
  }),
).pipe(Command.withDescription("List installed Pi runtime slots"));

const installSubcommand = Command.make("install", { minor: minorArg }, ({ minor }) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeSlotManager;
    const binPath = yield* runtime.ensureSlot(minor);
    yield* Console.log(`installed pi ${minor} at ${binPath}`);
  }),
).pipe(Command.withDescription("Install a Pi runtime slot (idempotent)"));

const removeSubcommand = Command.make("remove", { minor: minorArg }, ({ minor }) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeSlotManager;
    const result = yield* runtime.removeSlot(minor).pipe(
      Effect.catchTag("RuntimeSlotError", (e) =>
        Effect.gen(function* () {
          yield* Console.error(`pihub runtime remove: ${e.message}`);
          process.exitCode = 2;
          return null;
        }),
      ),
    );
    if (result === null) return;
    yield* Console.log(`removed pi ${minor}`);
  }),
).pipe(Command.withDescription("Remove an unreferenced Pi runtime slot"));

export const runtimeCommand = Command.make("runtime").pipe(
  Command.withDescription("Manage Pi runtime slots under ~/.pihub/runtime/pi/<minor>/"),
  Command.withSubcommands([listSubcommand, installSubcommand, removeSubcommand]),
);

export const gcRuntimeCommand = Command.make("gc-runtime", {}, () =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeSlotManager;
    const deleted = yield* runtime.gc;
    if (deleted.length === 0) {
      yield* Console.log("(no unreferenced slots)");
      return;
    }
    for (const minor of deleted) yield* Console.log(`removed pi ${minor}`);
    yield* Console.log(`total deleted: ${deleted.length}`);
  }),
).pipe(Command.withDescription("Remove all Pi runtime slots with refcount 0"));
