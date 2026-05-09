#!/usr/bin/env bun
import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import {
  GitClient,
  GithubApi,
  Installer,
  LockfileStore,
  ManifestParser,
  NpmRegistry,
  Paths,
  Profile,
  RegistryStore,
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
);

const Leaves = Layer.mergeAll(
  ShapeDetector.Live,
  ManifestParser.Live,
  SourceFetcher.Live,
  Profile.Live,
  LockfileStore.Live,
  RegistryStore.Live,
).pipe(Layer.provideMerge(Base));

const AppLayer = Installer.Live.pipe(Layer.provideMerge(Leaves));

const cli = Command.run(rootCommand, {
  name: "pihub",
  version: CLI_VERSION,
});

cli(process.argv).pipe(Effect.provide(AppLayer), BunRuntime.runMain);
