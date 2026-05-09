import { Command } from "@effect/cli";
import { aliasCommand } from "./commands/alias.js";
import { configCommand } from "./commands/config.js";
import { describeCommand } from "./commands/describe.js";
import { envCommand } from "./commands/env.js";
import { gcLogsCommand } from "./commands/gc-logs.js";
import { installCommand } from "./commands/install.js";
import { invokeCommand } from "./commands/invoke.js";
import { listCommand } from "./commands/list.js";
import { logsCommand } from "./commands/logs.js";
import { removeCommand } from "./commands/remove.js";
import { runCommand } from "./commands/run.js";
import { gcRuntimeCommand, runtimeCommand } from "./commands/runtime.js";
import { updateCommand } from "./commands/update.js";

export const rootCommand = Command.make("pihub").pipe(
  Command.withDescription(
    "Local-first operational runtime for executable AI sub-agents (Pi-first).",
  ),
  Command.withSubcommands([
    installCommand,
    listCommand,
    describeCommand,
    invokeCommand,
    runCommand,
    removeCommand,
    updateCommand,
    envCommand,
    aliasCommand,
    logsCommand,
    gcLogsCommand,
    runtimeCommand,
    gcRuntimeCommand,
    configCommand,
  ]),
);
