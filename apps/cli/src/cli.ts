#!/usr/bin/env bun
import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import {
  AliasStore,
  BunInstaller,
  Describe,
  EnvResolver,
  EnvStore,
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

// EnvResolver depends on EnvStore + Paths; chain so the merged layer
// surfaces both Resolver and Store outputs to the rest of the app.
const EnvLayers = EnvResolver.Live.pipe(Layer.provideMerge(EnvStore.Live));

// AliasStore depends on RegistryStore; chain so AliasStore.Live's RegistryStore
// dep resolves through the same instance that Installer/Invoker see.
const AliasLayers = AliasStore.Live.pipe(Layer.provideMerge(RegistryStore.Live));

const Leaves = Layer.mergeAll(
  ShapeDetector.Live,
  ManifestParser.Live,
  SourceFetcher.Live,
  Profile.Live,
  LockfileStore.Live,
  RuntimeSlotManager.Live,
  AliasLayers,
  EnvLayers,
).pipe(Layer.provideMerge(Base));

const AppLayer = Layer.mergeAll(Installer.Live, Describe.Live, Invoker.Live).pipe(
  Layer.provideMerge(Leaves),
);

const cli = Command.run(rootCommand, {
  name: "pihub",
  version: CLI_VERSION,
});

cli(process.argv).pipe(Effect.provide(AppLayer), BunRuntime.runMain);
