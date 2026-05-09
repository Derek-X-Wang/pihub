import { Command } from "@effect/cli";
import { describeCommand } from "./commands/describe.js";
import { installCommand } from "./commands/install.js";
import { listCommand } from "./commands/list.js";

const invokeStub = Command.make("invoke").pipe(
  Command.withDescription("invoke an agent (implemented in issue #8)"),
);

export const rootCommand = Command.make("pihub").pipe(
  Command.withDescription(
    "Local-first operational runtime for executable AI sub-agents (Pi-first).",
  ),
  Command.withSubcommands([installCommand, listCommand, describeCommand, invokeStub]),
);
