import { Args, Command, Options } from "@effect/cli";
import { Updater, type UpdateOptions, type UpdateResult } from "@pihub/core";
import { Console, Effect, Option } from "effect";

const agentArg = Args.text({ name: "agent" }).pipe(
  Args.optional,
  Args.withDescription(
    "Agent root to update; omit to update every installed agent in registry order",
  ),
);

const dryRunFlag = Options.boolean("dry-run").pipe(
  Options.withDescription("Print the diff but do not change disk state"),
);

const frozenFlag = Options.boolean("frozen").pipe(
  Options.withDescription("Exit 2 if any update would change state (CI drift detection)"),
);

const renderResult = (r: UpdateResult): string => {
  switch (r.kind) {
    case "linked-skipped":
      return `${r.agentRoot}: skipped (linked)`;
    case "no-change":
      return `${r.agentRoot}: up to date (${r.oldCommitSha})`;
    case "applied":
      return `${r.agentRoot}: ${r.oldCommitSha} → ${r.newCommitSha}${
        r.oldPiSlot !== r.newPiSlot ? ` (pi ${r.oldPiSlot} → ${r.newPiSlot})` : ""
      }`;
    case "dry-run-would-apply":
      return `${r.agentRoot}: WOULD UPDATE ${r.oldCommitSha} → ${r.newCommitSha}${
        r.oldPiSlot !== r.newPiSlot ? ` (pi ${r.oldPiSlot} → ${r.newPiSlot})` : ""
      }`;
  }
};

export const updateCommand = Command.make(
  "update",
  { agent: agentArg, dryRun: dryRunFlag, frozen: frozenFlag },
  ({ agent, dryRun, frozen }) =>
    Effect.gen(function* () {
      const updater = yield* Updater;
      const opts: UpdateOptions = {};
      if (dryRun) (opts as { dryRun: boolean }).dryRun = true;
      if (frozen) (opts as { frozen: boolean }).frozen = true;

      if (Option.isSome(agent)) {
        const result = yield* updater.update(agent.value, opts).pipe(
          Effect.catchTag("FrozenDriftError", (e) =>
            Effect.gen(function* () {
              yield* Console.error(`pihub update --frozen: ${e.message}`);
              process.exitCode = 2;
              return null;
            }),
          ),
          Effect.catchTag("AgentNotFoundError", (e) =>
            Effect.gen(function* () {
              yield* Console.error(`pihub update: ${e.message}`);
              process.exitCode = 2;
              return null;
            }),
          ),
        );
        if (result === null) return;
        yield* Console.log(renderResult(result));
        return;
      }

      const all = yield* updater.updateAll(opts);
      let driftDetected = false;
      for (const item of all) {
        if (item.result) {
          yield* Console.log(renderResult(item.result));
        } else {
          if (item.error?.includes("FrozenDriftError")) {
            driftDetected = true;
          }
          yield* Console.error(`${item.agentRoot}: ${item.error}`);
        }
      }
      if (frozen && driftDetected) process.exitCode = 2;
    }),
).pipe(
  Command.withDescription(
    "Re-resolve installed agents — update lockfile, refetch repo, bump pi runtime slot if deps changed",
  ),
);
