import { Command } from "@effect/cli";
import { aliasCommand } from "./commands/alias.js";
import { describeCommand } from "./commands/describe.js";
import { envCommand } from "./commands/env.js";
import { installCommand } from "./commands/install.js";
import { invokeCommand } from "./commands/invoke.js";
import { listCommand } from "./commands/list.js";

export const rootCommand = Command.make("pihub").pipe(
  Command.withDescription(
    "Local-first operational runtime for executable AI sub-agents (Pi-first).",
  ),
  Command.withSubcommands([
    installCommand,
    listCommand,
    describeCommand,
    invokeCommand,
    envCommand,
    aliasCommand,
  ]),
);
