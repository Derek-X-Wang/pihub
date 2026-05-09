import { Args, Command, Options } from "@effect/cli";
import { EnvStore, Paths } from "@pihub/core";
import { Console, Effect, Option } from "effect";

const agentOption = Options.text("agent").pipe(
  Options.optional,
  Options.withDescription("Apply to a single agent (defaults to the global ~/.pihub/env layer)"),
);

const showValuesFlag = Options.boolean("show-values").pipe(
  Options.withDescription(
    "Print values un-masked (use only when you intend to read secrets aloud)",
  ),
);

const setArg = Args.text({ name: "key=value" }).pipe(Args.withDescription("KEY=value pair to set"));

const unsetArg = Args.text({ name: "key" }).pipe(Args.withDescription("KEY to remove"));

interface PathsShape {
  readonly globalEnv: string;
  readonly agentEnv: (name: string) => string;
}

const targetPath = (
  paths: PathsShape,
  agent: Option.Option<string>,
): { path: string; label: string } =>
  Option.match(agent, {
    onNone: () => ({ path: paths.globalEnv, label: "global" }),
    onSome: (n) => ({ path: paths.agentEnv(n), label: `agent:${n}` }),
  });

const maskValue = (v: string): string => {
  if (v.length === 0) return "";
  if (v.length <= 4) return "*".repeat(v.length);
  return `${v.slice(0, 2)}${"*".repeat(Math.max(4, v.length - 4))}${v.slice(-2)}`;
};

const setSubcommand = Command.make("set", { kv: setArg, agent: agentOption }, ({ kv, agent }) =>
  Effect.gen(function* () {
    const eq = kv.indexOf("=");
    if (eq <= 0) {
      yield* Console.error(`pihub env set: malformed KEY=value, got: ${kv}`);
      process.exitCode = 2;
      return;
    }
    const key = kv.slice(0, eq).trim();
    const value = kv.slice(eq + 1);
    const paths = yield* Paths;
    const store = yield* EnvStore;
    const t = targetPath(paths, agent);
    yield* store.set(t.path, key, value);
    yield* Console.log(`set ${key} (${t.label})`);
  }),
).pipe(Command.withDescription("Set an env var (per-agent with --agent, else global)"));

const unsetSubcommand = Command.make(
  "unset",
  { key: unsetArg, agent: agentOption },
  ({ key, agent }) =>
    Effect.gen(function* () {
      const paths = yield* Paths;
      const store = yield* EnvStore;
      const t = targetPath(paths, agent);
      yield* store.unset(t.path, key);
      yield* Console.log(`unset ${key} (${t.label})`);
    }),
).pipe(Command.withDescription("Remove an env var from the named layer"));

const listSubcommand = Command.make(
  "list",
  { agent: agentOption, showValues: showValuesFlag },
  ({ agent, showValues }) =>
    Effect.gen(function* () {
      const paths = yield* Paths;
      const store = yield* EnvStore;
      const layers: ReadonlyArray<{ label: string; values: Record<string, string> }> = [
        { label: "global", values: yield* store.read(paths.globalEnv) },
        ...(Option.isSome(agent)
          ? [
              {
                label: `agent:${agent.value}`,
                values: yield* store.read(paths.agentEnv(agent.value)),
              },
            ]
          : []),
      ];
      if (showValues) {
        yield* Console.error(
          "warning: --show-values prints secrets un-masked. Avoid in shared terminals.",
        );
      }
      const resolved: Record<string, string> = {};
      for (const layer of layers) Object.assign(resolved, layer.values);
      if (showValues) {
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === "string" && k in resolved) resolved[k] = v;
        }
      }
      const renderLayer = (label: string, values: Record<string, string>) => {
        const keys = Object.keys(values).sort();
        if (keys.length === 0) return `[${label}] (empty)`;
        const lines = keys.map(
          (k) => `  ${k}=${showValues ? (values[k] as string) : maskValue(values[k] as string)}`,
        );
        return `[${label}]\n${lines.join("\n")}`;
      };
      for (const layer of layers) yield* Console.log(renderLayer(layer.label, layer.values));
      yield* Console.log(renderLayer("effective (global < per-agent < shell)", resolved));
    }),
).pipe(Command.withDescription("List env vars per-layer with masked values"));

export const envCommand = Command.make("env").pipe(
  Command.withDescription("Manage env vars used by `pihub invoke`"),
  Command.withSubcommands([setSubcommand, listSubcommand, unsetSubcommand]),
);
