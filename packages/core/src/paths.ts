import { Context, Layer } from "effect";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Filesystem layout under `~/.pihub/`. Live reads `os.homedir()`; tests inject
 * a temp dir via `Paths.Test(rootDir)` so every fs touch lands in isolation.
 */
export interface PathsShape {
  readonly home: string;
  readonly registry: string;
  readonly globalEnv: string;
  readonly aliases: string;
  readonly config: string;
  readonly logsRoot: string;
  readonly agentRoot: (name: string) => string;
  readonly agentRepo: (name: string) => string;
  readonly agentProfile: (name: string) => string;
  readonly agentEnv: (name: string) => string;
  readonly agentLockfile: (name: string) => string;
  readonly runtimeSlot: (minor: string) => string;
}

const makePaths = (root: string): PathsShape => ({
  home: root,
  registry: path.join(root, "registry.json"),
  globalEnv: path.join(root, "env"),
  aliases: path.join(root, "aliases.json"),
  config: path.join(root, "config.json"),
  logsRoot: path.join(root, "logs"),
  agentRoot: (n) => path.join(root, "agents", n),
  agentRepo: (n) => path.join(root, "agents", n, "repo"),
  agentProfile: (n) => path.join(root, "agents", n, "profile"),
  agentEnv: (n) => path.join(root, "agents", n, "env"),
  agentLockfile: (n) => path.join(root, "agents", n, "install.lock.json"),
  runtimeSlot: (minor) => path.join(root, "runtime", "pi", minor),
});

export class Paths extends Context.Tag("Paths")<Paths, PathsShape>() {
  static readonly Live = Layer.succeed(Paths, makePaths(path.join(os.homedir(), ".pihub")));
  static readonly Test = (rootDir: string) => Layer.succeed(Paths, makePaths(rootDir));
}
