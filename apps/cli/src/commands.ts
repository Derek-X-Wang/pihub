import { Command } from "@effect/cli";

const installStub = Command.make("install").pipe(
  Command.withDescription("install an agent (implemented in issue #3+)"),
);

const listStub = Command.make("list").pipe(
  Command.withDescription("list installed agents (implemented in issue #3)"),
);

const invokeStub = Command.make("invoke").pipe(
  Command.withDescription("invoke an agent (implemented in issue #8)"),
);

export const rootCommand = Command.make("pihub").pipe(
  Command.withDescription(
    "Local-first operational runtime for executable AI sub-agents (Pi-first).",
  ),
  Command.withSubcommands([installStub, listStub, invokeStub]),
);
