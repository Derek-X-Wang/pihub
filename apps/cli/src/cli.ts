#!/usr/bin/env bun
import { Command } from "@effect/cli";
import { BunContext, BunRuntime } from "@effect/platform-bun";
import {
  AliasStore,
  BunInstaller,
  ConfigStore,
  Describe,
  Doctor,
  EnvResolver,
  EnvStore,
  EphemeralRunner,
  GitClient,
  GithubApi,
  Installer,
  Invoker,
  LockfileStore,
  LogStore,
  ManifestParser,
  NpmRegistry,
  Paths,
  PiInstaller,
  Profile,
  RegistryStore,
  Remover,
  RuntimeSlotManager,
  ShapeDetector,
  SourceFetcher,
  TarExtractor,
  Updater,
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

// AliasStore + RuntimeSlotManager both depend on RegistryStore. Chain the
// three so the merged Leaves layer surfaces a single RegistryStore instance
// to every consumer (Installer, Invoker, Describe).
const RegistryLayers = Layer.mergeAll(AliasStore.Live, RuntimeSlotManager.Live).pipe(
  Layer.provideMerge(RegistryStore.Live),
);

const Leaves = Layer.mergeAll(
  ShapeDetector.Live,
  ManifestParser.Live,
  SourceFetcher.Live,
  Profile.Live,
  LockfileStore.Live,
  LogStore.Live,
  ConfigStore.Live,
  RegistryLayers,
  EnvLayers,
).pipe(Layer.provideMerge(Base));

// EphemeralRunner depends on Invoker. Chain it so Invoker.Live's Invoker
// output is visible inside EphemeralRunner.Live's Effect.gen.
const InvokerLayers = EphemeralRunner.Live.pipe(Layer.provideMerge(Invoker.Live));

const AppLayer = Layer.mergeAll(
  Installer.Live,
  Describe.Live,
  Remover.Live,
  Updater.Live,
  Doctor.Live,
  InvokerLayers,
).pipe(Layer.provideMerge(Leaves));

const cli = Command.run(rootCommand, {
  name: "pihub",
  version: CLI_VERSION,
});

cli(process.argv).pipe(Effect.provide(AppLayer), BunRuntime.runMain);
