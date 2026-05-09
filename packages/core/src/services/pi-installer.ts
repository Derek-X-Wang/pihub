import { spawn } from "node:child_process";
import * as path from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import { PiInstallError } from "../errors.js";

export interface PiInstallerShape {
  /**
   * Run `<pi-binary> install <source>` with the agent's profile env so Pi
   * loads extensions/skills/prompts/themes into `<profile>` rather than the
   * caller's `~/.pi`. Used by the shape-α install branch.
   */
  readonly install: (
    binary: string,
    source: string,
    profile: string,
  ) => Effect.Effect<void, PiInstallError>;
}

export class PiInstaller extends Context.Tag("PiInstaller")<PiInstaller, PiInstallerShape>() {
  static readonly Live = Layer.succeed(PiInstaller, {
    install: (binary, source, profile) =>
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            const env: Record<string, string> = {
              ...(process.env as Record<string, string>),
              PI_CODING_AGENT_DIR: profile,
              PI_PACKAGE_DIR: path.join(profile, "packages"),
            };
            const child = spawn(binary, ["install", source], {
              env,
              stdio: ["ignore", "pipe", "pipe"],
            });
            const stderrChunks: Buffer[] = [];
            child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));
            child.on("error", reject);
            child.on("close", (code) => {
              if (code === 0) {
                resolve();
              } else {
                reject(
                  new Error(
                    `pi install exited ${code}: ${Buffer.concat(stderrChunks)
                      .toString("utf8")
                      .trim()}`,
                  ),
                );
              }
            });
          }),
        catch: (e) => new PiInstallError({ binary, source, profile, message: String(e) }),
      }),
  });

  /**
   * Test layer: records every install request without spawning Pi. Tests
   * compose this with `RuntimeSlotManager.Test` to drive Installer's α path
   * end-to-end purely in-memory.
   */
  static readonly Test = () =>
    Layer.effect(
      PiInstaller,
      Effect.gen(function* () {
        const calls = yield* Ref.make<Array<{ binary: string; source: string; profile: string }>>(
          [],
        );
        return {
          install: (binary, source, profile) =>
            Ref.update(calls, (xs) => [...xs, { binary, source, profile }]),
        } satisfies PiInstallerShape;
      }),
    );
}
