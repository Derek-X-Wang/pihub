import { FileSystem } from "@effect/platform";
import { LogMeta } from "@pihub/schema";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import * as path from "node:path";
import { LogNotFoundError, LogStoreError } from "../errors.js";
import { Paths } from "../paths.js";

const decodeMeta = Schema.decodeUnknown(Schema.parseJson(LogMeta));
const encodeMeta = (m: LogMeta) => JSON.stringify(m, null, 2) + "\n";

export const DEFAULT_LOG_RETENTION = 50;

export interface RecordInput {
  readonly invocationId: string;
  readonly agent: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly exitCode: number;
  readonly firstPromptLine: string;
  /** Raw JSONL stdout from `pi --mode json`. */
  readonly raw: string;
}

export interface LogStoreShape {
  /** Persist one invocation's log + sidecar meta. */
  readonly record: (input: RecordInput) => Effect.Effect<void, LogStoreError>;
  /** Index of all invocations attributed to `agent`, newest first. */
  readonly listForAgent: (
    agent: string,
    opts?: { readonly limit?: number; readonly since?: string },
  ) => Effect.Effect<ReadonlyArray<LogMeta>, LogStoreError>;
  /** Raw JSONL contents of the named invocation. */
  readonly readEvents: (
    invocationId: string,
  ) => Effect.Effect<string, LogStoreError | LogNotFoundError>;
  /**
   * Prune `agent`'s logs back to `retention` newest. Returns the number of
   * invocations deleted.
   */
  readonly prune: (agent: string, retention: number) => Effect.Effect<number, LogStoreError>;
  /**
   * Same as `prune` but applied to every agent that has any log on disk.
   * Returns the per-agent deletion counts.
   */
  readonly pruneAll: (
    retention: number,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly agent: string; readonly deleted: number }>,
    LogStoreError
  >;
}

interface LogPaths {
  readonly logsRoot: string;
  readonly dateDir: (date: string) => string;
  readonly eventsFile: (date: string, invocationId: string) => string;
  readonly metaFile: (date: string, invocationId: string) => string;
}

const buildLogPaths = (logsRoot: string): LogPaths => ({
  logsRoot,
  dateDir: (date) => path.join(logsRoot, date),
  eventsFile: (date, id) => path.join(logsRoot, date, `${id}.jsonl`),
  metaFile: (date, id) => path.join(logsRoot, date, `${id}.meta.json`),
});

const dateOf = (iso: string): string => iso.slice(0, 10);

interface MetaWithLocation {
  readonly meta: LogMeta;
  readonly date: string;
}

const collectAll = (
  fs: FileSystem.FileSystem,
  lp: LogPaths,
): Effect.Effect<ReadonlyArray<MetaWithLocation>, LogStoreError> =>
  Effect.gen(function* () {
    const exists = yield* fs.exists(lp.logsRoot).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return [];
    const dates = yield* fs
      .readDirectory(lp.logsRoot)
      .pipe(
        Effect.mapError(
          (e) => new LogStoreError({ message: `readDirectory failed: ${String(e)}` }),
        ),
      );
    const out: Array<MetaWithLocation> = [];
    for (const date of dates) {
      const dateDir = lp.dateDir(date);
      const stat = yield* fs
        .stat(dateDir)
        .pipe(Effect.catchAll(() => Effect.succeed(null as never)));
      if (stat === null || stat.type !== "Directory") continue;
      const entries = yield* fs.readDirectory(dateDir).pipe(
        Effect.mapError(
          (e) =>
            new LogStoreError({
              message: `readDirectory ${dateDir} failed: ${String(e)}`,
            }),
        ),
      );
      for (const entry of entries) {
        if (!entry.endsWith(".meta.json")) continue;
        const metaPath = path.join(dateDir, entry);
        const raw = yield* fs
          .readFileString(metaPath)
          .pipe(Effect.catchAll(() => Effect.succeed("")));
        if (raw.length === 0) continue;
        const decoded = yield* decodeMeta(raw).pipe(Effect.option);
        if (decoded._tag === "Some") {
          out.push({ meta: decoded.value, date });
        }
      }
    }
    return out;
  });

export class LogStore extends Context.Tag("LogStore")<LogStore, LogStoreShape>() {
  static readonly Live = Layer.effect(
    LogStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Paths;
      const lp = buildLogPaths(paths.logsRoot);

      const record = (input: RecordInput) =>
        Effect.gen(function* () {
          const date = dateOf(input.startedAt);
          const dir = lp.dateDir(date);
          yield* fs.makeDirectory(dir, { recursive: true }).pipe(
            Effect.mapError(
              (e) =>
                new LogStoreError({
                  message: `failed to mkdir ${dir}: ${String(e)}`,
                }),
            ),
          );
          yield* fs.writeFileString(lp.eventsFile(date, input.invocationId), input.raw).pipe(
            Effect.mapError(
              (e) =>
                new LogStoreError({
                  message: `failed to write events for ${input.invocationId}: ${String(e)}`,
                }),
            ),
          );
          const meta: LogMeta = {
            invocationId: input.invocationId,
            agent: input.agent,
            startedAt: input.startedAt,
            durationMs: input.durationMs,
            exitCode: input.exitCode,
            firstPromptLine: input.firstPromptLine,
          };
          yield* fs.writeFileString(lp.metaFile(date, input.invocationId), encodeMeta(meta)).pipe(
            Effect.mapError(
              (e) =>
                new LogStoreError({
                  message: `failed to write meta for ${input.invocationId}: ${String(e)}`,
                }),
            ),
          );
        });

      const listForAgent: LogStoreShape["listForAgent"] = (agent, opts) =>
        Effect.gen(function* () {
          const all = yield* collectAll(fs, lp);
          let filtered = all
            .filter((m) => m.meta.agent === agent)
            .sort((a, b) => (a.meta.startedAt < b.meta.startedAt ? 1 : -1));
          if (opts?.since) {
            const since = opts.since;
            filtered = filtered.filter((m) => m.meta.startedAt >= since);
          }
          if (opts?.limit !== undefined) {
            filtered = filtered.slice(0, opts.limit);
          }
          return filtered.map((m) => m.meta);
        });

      const readEvents: LogStoreShape["readEvents"] = (invocationId) =>
        Effect.gen(function* () {
          const all = yield* collectAll(fs, lp);
          const hit = all.find((m) => m.meta.invocationId === invocationId);
          if (!hit) {
            return yield* Effect.fail(
              new LogNotFoundError({
                invocationId,
                message: `no log found for invocation-id ${invocationId}`,
              }),
            );
          }
          return yield* fs.readFileString(lp.eventsFile(hit.date, invocationId)).pipe(
            Effect.mapError(
              (e) =>
                new LogStoreError({
                  message: `failed to read events for ${invocationId}: ${String(e)}`,
                }),
            ),
          );
        });

      const prune: LogStoreShape["prune"] = (agent, retention) =>
        Effect.gen(function* () {
          const all = yield* collectAll(fs, lp);
          const sorted = all
            .filter((m) => m.meta.agent === agent)
            .sort((a, b) => (a.meta.startedAt < b.meta.startedAt ? 1 : -1));
          const toDelete = sorted.slice(retention);
          for (const item of toDelete) {
            yield* fs
              .remove(lp.eventsFile(item.date, item.meta.invocationId))
              .pipe(Effect.catchAll(() => Effect.void));
            yield* fs
              .remove(lp.metaFile(item.date, item.meta.invocationId))
              .pipe(Effect.catchAll(() => Effect.void));
          }
          return toDelete.length;
        });

      const pruneAll: LogStoreShape["pruneAll"] = (retention) =>
        Effect.gen(function* () {
          const all = yield* collectAll(fs, lp);
          const agents = Array.from(new Set(all.map((m) => m.meta.agent))).sort();
          const out: Array<{ agent: string; deleted: number }> = [];
          for (const agent of agents) {
            const deleted = yield* prune(agent, retention);
            out.push({ agent, deleted });
          }
          return out;
        });

      return { record, listForAgent, readEvents, prune, pruneAll } satisfies LogStoreShape;
    }),
  );

  /**
   * Test layer: in-memory map keyed by invocationId. Skips the disk and the
   * .jsonl/.meta split — tests that drive Invoker only need to assert that
   * `record` was called with the right shape.
   */
  static readonly Test = () =>
    Layer.effect(
      LogStore,
      Effect.gen(function* () {
        const records = yield* Ref.make<Map<string, { meta: LogMeta; raw: string }>>(new Map());

        const recordOp: LogStoreShape["record"] = (input) =>
          Ref.update(
            records,
            (m) =>
              new Map([
                ...m,
                [
                  input.invocationId,
                  {
                    meta: {
                      invocationId: input.invocationId,
                      agent: input.agent,
                      startedAt: input.startedAt,
                      durationMs: input.durationMs,
                      exitCode: input.exitCode,
                      firstPromptLine: input.firstPromptLine,
                    },
                    raw: input.raw,
                  },
                ],
              ]),
          );

        return {
          record: recordOp,
          listForAgent: (agent, opts) =>
            Ref.get(records).pipe(
              Effect.map((m) => {
                let xs = [...m.values()]
                  .filter((r) => r.meta.agent === agent)
                  .map((r) => r.meta)
                  .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
                if (opts?.since) {
                  const since = opts.since;
                  xs = xs.filter((m2) => m2.startedAt >= since);
                }
                if (opts?.limit !== undefined) xs = xs.slice(0, opts.limit);
                return xs;
              }),
            ),
          readEvents: (invocationId) =>
            Effect.gen(function* () {
              const m = yield* Ref.get(records);
              const hit = m.get(invocationId);
              if (!hit) {
                return yield* Effect.fail(
                  new LogNotFoundError({
                    invocationId,
                    message: `no log for ${invocationId}`,
                  }),
                );
              }
              return hit.raw;
            }),
          prune: (agent, retention) =>
            Ref.modify(records, (m) => {
              const sorted = [...m.entries()]
                .filter(([, r]) => r.meta.agent === agent)
                .sort(([, a], [, b]) => (a.meta.startedAt < b.meta.startedAt ? 1 : -1));
              const toDelete = sorted.slice(retention).map(([id]) => id);
              const next = new Map(m);
              for (const id of toDelete) next.delete(id);
              return [toDelete.length, next];
            }),
          pruneAll: (retention) =>
            Effect.gen(function* () {
              const m = yield* Ref.get(records);
              const agents = Array.from(new Set([...m.values()].map((r) => r.meta.agent))).sort();
              const out: Array<{ agent: string; deleted: number }> = [];
              for (const a of agents) {
                const sorted = [...m.entries()]
                  .filter(([, r]) => r.meta.agent === a)
                  .sort(([, x], [, y]) => (x.meta.startedAt < y.meta.startedAt ? 1 : -1));
                const toDelete = sorted.slice(retention).map(([id]) => id);
                yield* Ref.update(records, (cur) => {
                  const next = new Map(cur);
                  for (const id of toDelete) next.delete(id);
                  return next;
                });
                out.push({ agent: a, deleted: toDelete.length });
              }
              return out;
            }),
        } satisfies LogStoreShape;
      }),
    );
}
