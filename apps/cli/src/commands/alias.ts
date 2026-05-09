import { Args, Command } from "@effect/cli";
import { AliasStore } from "@pihub/core";
import { Console, Effect } from "effect";

const setArg = Args.text({ name: "short=canonical" }).pipe(
  Args.withDescription("alias mapping in `short=canonical` form"),
);

const removeArg = Args.text({ name: "short" }).pipe(Args.withDescription("alias to remove"));

const setSubcommand = Command.make("set", { kv: setArg }, ({ kv }) =>
  Effect.gen(function* () {
    const eq = kv.indexOf("=");
    if (eq <= 0) {
      yield* Console.error(`pihub alias set: malformed short=canonical, got: ${kv}`);
      process.exitCode = 2;
      return;
    }
    const short = kv.slice(0, eq).trim();
    const canonical = kv.slice(eq + 1).trim();
    if (short.length === 0 || canonical.length === 0) {
      yield* Console.error(`pihub alias set: empty short or canonical name`);
      process.exitCode = 2;
      return;
    }
    const store = yield* AliasStore;
    const result = yield* store.set(short, canonical).pipe(
      Effect.catchTag("AliasCollisionError", (e) =>
        Effect.gen(function* () {
          yield* Console.error(`pihub alias: ${e.message}`);
          process.exitCode = 2;
          return null;
        }),
      ),
    );
    if (result === null) return;
    yield* Console.log(`alias ${short} -> ${canonical}`);
  }),
).pipe(Command.withDescription("Register a new alias"));

const listSubcommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const store = yield* AliasStore;
    const a = yield* store.read;
    const keys = Object.keys(a.map).sort();
    if (keys.length === 0) {
      yield* Console.log("(no aliases)");
      return;
    }
    const width = Math.max(...keys.map((k) => k.length));
    for (const k of keys) {
      yield* Console.log(`${k.padEnd(width)}  -> ${a.map[k]}`);
    }
  }),
).pipe(Command.withDescription("List registered aliases"));

const removeSubcommand = Command.make("remove", { short: removeArg }, ({ short }) =>
  Effect.gen(function* () {
    const store = yield* AliasStore;
    const result = yield* store.remove(short).pipe(
      Effect.catchTag("AliasNotFoundError", (e) =>
        Effect.gen(function* () {
          yield* Console.error(`pihub alias: ${e.message}`);
          process.exitCode = 2;
          return null;
        }),
      ),
    );
    if (result === null) return;
    yield* Console.log(`removed ${short}`);
  }),
).pipe(Command.withDescription("Remove an alias"));

export const aliasCommand = Command.make("alias").pipe(
  Command.withDescription("Manage short aliases for canonical agent names"),
  Command.withSubcommands([setSubcommand, listSubcommand, removeSubcommand]),
);
