import { Args, Command, Options } from "@effect/cli";
import { Describe } from "@pihub/core";
import { Console, Effect } from "effect";

const nameArg = Args.text({ name: "agent" }).pipe(
  Args.withDescription("Canonical agent name (e.g. `sample-beta-agent:scout`)"),
);

const jsonFlag = Options.boolean("json").pipe(
  Options.withDescription("Emit the description as a JSON object (AgentDescription schema)"),
);

const fmtList = (xs: ReadonlyArray<string>) => (xs.length === 0 ? "(none)" : xs.join(", "));

export const describeCommand = Command.make(
  "describe",
  { name: nameArg, json: jsonFlag },
  ({ name, json }) =>
    Effect.gen(function* () {
      const describe = yield* Describe;
      const desc = yield* describe.describe(name).pipe(
        Effect.catchTag("AgentNotFoundError", (e) =>
          Effect.gen(function* () {
            yield* Console.error(`pihub describe: ${e.message}`);
            // Exit 2 = invalid input per CONTEXT.md error envelope.
            process.exitCode = 2;
            return null;
          }),
        ),
      );
      if (desc === null) return;

      if (json) {
        yield* Console.log(JSON.stringify(desc, null, 2));
        return;
      }

      const lines = [
        `name:         ${desc.name}${desc.linked ? " [linked]" : ""}`,
        `shape:        ${desc.shape}`,
        `source:       ${desc.source}`,
        `ref:          ${desc.ref}`,
        `commitSha:    ${desc.commitSha}`,
        `piSlot:       ${desc.piSlot}`,
        `env:          ${fmtList(desc.envDeclared)}`,
        `permissions:  ${fmtList(desc.permissions)} (advisory only — not enforced v1)`,
        `description:  ${desc.description}`,
        `invoke:       ${desc.invoke}`,
        `installedAt:  ${desc.installedAt}`,
      ];
      for (const l of lines) yield* Console.log(l);
    }),
).pipe(Command.withDescription("Describe an installed agent"));
