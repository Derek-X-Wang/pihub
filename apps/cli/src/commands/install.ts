import { Args, Command, Options } from "@effect/cli";
import { Installer } from "@pihub/core";
import { Console, Effect } from "effect";

const sourceArg = Args.text({ name: "source" }).pipe(
  Args.withDescription(
    "Local path or source URL: github:owner/repo[@ref], https://github.com/owner/repo[@ref], npm:[@scope/]pkg[@version], or a local path",
  ),
);

const frozenFlag = Options.boolean("frozen").pipe(
  Options.withDescription(
    "CI mode: re-resolve and exit 2 if state would differ from the existing lockfile",
  ),
);

const linkFlag = Options.boolean("link").pipe(
  Options.withDescription(
    "Live-dev mode: symlink the local source instead of copying (local sources only)",
  ),
);

export const installCommand = Command.make(
  "install",
  { source: sourceArg, frozen: frozenFlag, link: linkFlag },
  ({ source, frozen, link }) =>
    Effect.gen(function* () {
      const installer = yield* Installer;
      const result = yield* installer.install(source, { frozen, link }).pipe(
        Effect.catchTag("FrozenDriftError", (e) =>
          Effect.gen(function* () {
            yield* Console.error(`pihub install --frozen: drift detected — ${e.message}`);
            // Exit 2 = invalid input per CONTEXT.md error envelope. Set the
            // process exit code now so BunRuntime preserves it on success.
            process.exitCode = 2;
            return null;
          }),
        ),
      );
      if (result === null) return;
      if (result.cached) {
        const note = frozen ? "verified frozen" : "idempotent re-install";
        yield* Console.log(`already installed: ${result.agentRoot} (${note})`);
      } else {
        yield* Console.log(`installed: ${result.agentRoot}${link ? " [linked]" : ""}`);
      }
      for (const entry of result.entries) {
        const marker = entry.linked ? " [linked]" : "";
        yield* Console.log(`  - ${entry.name}${marker}  ${entry.description}`);
      }
    }),
).pipe(Command.withDescription("Install an agent from a local path or remote source"));
