import { Command, Options } from "@effect/cli";
import { RegistryStore } from "@pihub/core";
import { Console, Effect } from "effect";

const padRight = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

const jsonFlag = Options.boolean("json").pipe(
  Options.withDescription("Emit the registry as JSON matching the @pihub/schema Registry shape"),
);

export const listCommand = Command.make("list", { json: jsonFlag }, ({ json }) =>
  Effect.gen(function* () {
    const registry = yield* RegistryStore;
    const reg = yield* registry.read;

    if (json) {
      yield* Console.log(JSON.stringify(reg, null, 2));
      return;
    }

    if (reg.agents.length === 0) {
      yield* Console.log("No agents installed. Run `pihub install <path>` first.");
      return;
    }

    const displayName = (name: string, linked: boolean) => (linked ? `${name} [linked]` : name);
    const nameWidth = Math.max(4, ...reg.agents.map((a) => displayName(a.name, a.linked).length));
    const shapeWidth = Math.max(5, ...reg.agents.map((a) => a.shape.length));
    const header = `${padRight("NAME", nameWidth)}  ${padRight("SHAPE", shapeWidth)}  DESCRIPTION`;
    yield* Console.log(header);
    yield* Console.log("-".repeat(header.length));
    for (const a of reg.agents) {
      yield* Console.log(
        `${padRight(displayName(a.name, a.linked), nameWidth)}  ${padRight(
          a.shape,
          shapeWidth,
        )}  ${a.description}`,
      );
    }
  }),
).pipe(Command.withDescription("List installed agents"));
