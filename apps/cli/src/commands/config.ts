import { Args, Command, Options } from "@effect/cli";
import { ConfigStore } from "@pihub/core";
import { CONFIG_KEYS, ConfigDefaults, type PihubConfig } from "@pihub/schema";
import { Console, Effect } from "effect";

const keyArg = Args.text({ name: "key" }).pipe(
  Args.withDescription(`config key. Valid: ${CONFIG_KEYS.join(", ")}`),
);

const valueArg = Args.text({ name: "value" }).pipe(
  Args.withDescription("value to set (validated against the key's type)"),
);

const jsonFlag = Options.boolean("json").pipe(
  Options.withDescription("Emit list output as JSON matching the PihubConfig schema"),
);

const renderValue = (v: unknown): string =>
  v === undefined ? "(default)" : typeof v === "string" ? v : JSON.stringify(v);

const getSubcommand = Command.make("get", { key: keyArg }, ({ key }) =>
  Effect.gen(function* () {
    const store = yield* ConfigStore;
    const c = yield* store.read;
    const value = (c as Record<string, unknown>)[key];
    if (value !== undefined) {
      yield* Console.log(renderValue(value));
      return;
    }
    const fallback = (ConfigDefaults as Record<string, unknown>)[key];
    if (fallback !== undefined) {
      yield* Console.log(renderValue(fallback));
      return;
    }
    yield* Console.log("(unset)");
  }),
).pipe(Command.withDescription("Print a config value (or its default)"));

const setSubcommand = Command.make("set", { key: keyArg, value: valueArg }, ({ key, value }) =>
  Effect.gen(function* () {
    const store = yield* ConfigStore;
    const result = yield* store.set(key, value).pipe(
      Effect.catchTag("ConfigInvalidError", (e) =>
        Effect.gen(function* () {
          yield* Console.error(`pihub config set ${e.key}: ${e.message}`);
          process.exitCode = 2;
          return null;
        }),
      ),
    );
    if (result === null) return;
    yield* Console.log(`set ${key}=${value}`);
  }),
).pipe(Command.withDescription("Set a config value (validated against the key's type)"));

const unsetSubcommand = Command.make("unset", { key: keyArg }, ({ key }) =>
  Effect.gen(function* () {
    const store = yield* ConfigStore;
    const result = yield* store.unset(key).pipe(
      Effect.catchTag("ConfigInvalidError", (e) =>
        Effect.gen(function* () {
          yield* Console.error(`pihub config unset: ${e.message}`);
          process.exitCode = 2;
          return null;
        }),
      ),
    );
    if (result === null) return;
    yield* Console.log(`unset ${key}`);
  }),
).pipe(Command.withDescription("Reset a key to its default value"));

const listSubcommand = Command.make("list", { json: jsonFlag }, ({ json }) =>
  Effect.gen(function* () {
    const store = yield* ConfigStore;
    const c = yield* store.read;
    if (json) {
      yield* Console.log(JSON.stringify(c, null, 2));
      return;
    }
    const keyWidth = Math.max(...CONFIG_KEYS.map((k: keyof PihubConfig) => k.length));
    yield* Console.log(`${"KEY".padEnd(keyWidth)}  CURRENT  (DEFAULT)`);
    yield* Console.log("-".repeat(keyWidth + 24));
    for (const k of CONFIG_KEYS) {
      const cur = (c as Record<string, unknown>)[k];
      const def = (ConfigDefaults as Record<string, unknown>)[k];
      const curRender = cur === undefined ? "—" : renderValue(cur);
      const defRender = def === undefined ? "—" : renderValue(def);
      yield* Console.log(`${k.padEnd(keyWidth)}  ${curRender}  (${defRender})`);
    }
  }),
).pipe(Command.withDescription("List every config key with current value + default"));

export const configCommand = Command.make("config").pipe(
  Command.withDescription("Manage PiHub-global config (~/.pihub/config.json)"),
  Command.withSubcommands([getSubcommand, setSubcommand, unsetSubcommand, listSubcommand]),
);
