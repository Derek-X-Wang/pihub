#!/usr/bin/env bun
import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import {
  BunInstaller,
  Describe,
  GitClient,
  GithubApi,
  Installer,
  Invoker,
  LockfileStore,
  ManifestParser,
  NpmRegistry,
  Paths,
  PiInstaller,
  Profile,
  RegistryStore,
  RuntimeSlotManager,
  ShapeDetector,
  SourceFetcher,
  TarExtractor,
} from "@pihub/core";
import { Effect, Layer } from "effect";
import { rootCommand } from "./commands.js";
import { CLI_VERSION } from "./version.js";

const Base = Layer.mergeAll(
  Paths.Live,
  BunContext.layer,
  GithubApi.Live,
  GitClient.Live,
  NpmRegistry.Live,
  TarExtractor.Live,
  BunInstaller.Live,
  PiInstaller.Live,
);

const Leaves = Layer.mergeAll(
  ShapeDetector.Live,
  ManifestParser.Live,
  SourceFetcher.Live,
  Profile.Live,
  LockfileStore.Live,
  RegistryStore.Live,
  RuntimeSlotManager.Live,
).pipe(Layer.provideMerge(Base));

const AppLayer = Layer.mergeAll(Installer.Live, Describe.Live, Invoker.Live).pipe(
  Layer.provideMerge(Leaves),
);

const cli = Command.run(rootCommand, {
  name: "pihub",
  version: CLI_VERSION,
});

cli(process.argv).pipe(Effect.provide(AppLayer), BunRuntime.runMain);
