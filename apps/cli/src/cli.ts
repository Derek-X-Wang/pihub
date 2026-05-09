#!/usr/bin/env bun
import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";
import { rootCommand } from "./commands.js";
import { CLI_VERSION } from "./version.js";

const cli = Command.run(rootCommand, {
  name: "pihub",
  version: CLI_VERSION,
});

cli(process.argv).pipe(Effect.provide(BunContext.layer), BunRuntime.runMain);
