import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Paths } from "../../src/paths.js";
import { LogStore } from "../../src/services/log-store.js";

const buildLayer = (homeDir: string) =>
  LogStore.Live.pipe(Layer.provide(Layer.mergeAll(Paths.Test(homeDir), BunContext.layer)));

const recordOne = (id: string, agent: string, startedAt: string, exit = 0) => ({
  invocationId: id,
  agent,
  startedAt,
  durationMs: 100,
  exitCode: exit,
  firstPromptLine: `prompt-${id}`,
  raw: `{"type":"session","id":"${id}"}\n`,
});

describe("LogStore (live, real FS)", () => {
  let home: string;

  beforeEach(async () => {
    home = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-logs-"));
  });

  afterEach(async () => {
    await fsp.rm(home, { recursive: true, force: true });
  });

  it.effect("record writes events + meta to ~/.pihub/logs/<date>/", () =>
    Effect.gen(function* () {
      const store = yield* LogStore;
      yield* store.record(recordOne("inv-1", "sample:scout", "2026-05-09T01:23:45.000Z"));
      const events = yield* Effect.promise(() =>
        fsp.readFile(path.join(home, "logs", "2026-05-09", "inv-1.jsonl"), "utf8"),
      );
      expect(events).toContain('"type":"session"');
      const meta = JSON.parse(
        yield* Effect.promise(() =>
          fsp.readFile(path.join(home, "logs", "2026-05-09", "inv-1.meta.json"), "utf8"),
        ),
      );
      expect(meta.agent).toBe("sample:scout");
      expect(meta.firstPromptLine).toBe("prompt-inv-1");
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("listForAgent returns newest-first; respects limit and since", () =>
    Effect.gen(function* () {
      const store = yield* LogStore;
      yield* store.record(recordOne("a", "x", "2026-05-09T01:00:00.000Z"));
      yield* store.record(recordOne("b", "x", "2026-05-09T02:00:00.000Z"));
      yield* store.record(recordOne("c", "x", "2026-05-09T03:00:00.000Z"));
      yield* store.record(recordOne("z", "y", "2026-05-09T04:00:00.000Z"));

      const list = yield* store.listForAgent("x");
      expect(list.map((m) => m.invocationId)).toEqual(["c", "b", "a"]);

      const limited = yield* store.listForAgent("x", { limit: 2 });
      expect(limited.map((m) => m.invocationId)).toEqual(["c", "b"]);

      const since = yield* store.listForAgent("x", { since: "2026-05-09T02:00:00.000Z" });
      expect(since.map((m) => m.invocationId)).toEqual(["c", "b"]);
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("readEvents returns the raw JSONL for a known invocation", () =>
    Effect.gen(function* () {
      const store = yield* LogStore;
      yield* store.record(recordOne("k", "x", "2026-05-09T01:00:00.000Z"));
      const raw = yield* store.readEvents("k");
      expect(raw).toContain('"id":"k"');
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("readEvents fails with LogNotFoundError for an unknown id", () =>
    Effect.gen(function* () {
      const store = yield* LogStore;
      const exit = yield* Effect.exit(store.readEvents("nope"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("LogNotFoundError");
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("prune keeps the newest N invocations for an agent", () =>
    Effect.gen(function* () {
      const store = yield* LogStore;
      // 5 invocations of agent x, retention 2 → 3 deleted (the older ones).
      const dates = ["01", "02", "03", "04", "05"];
      for (const d of dates) {
        yield* store.record(recordOne(`x-${d}`, "x", `2026-05-09T0${d}:00:00.000Z`));
      }
      const deleted = yield* store.prune("x", 2);
      expect(deleted).toBe(3);
      const list = yield* store.listForAgent("x");
      expect(list.map((m) => m.invocationId)).toEqual(["x-05", "x-04"]);
      // Also assert the underlying files are gone.
      const old = path.join(home, "logs", "2026-05-09", "x-01.jsonl");
      const stillThere = yield* Effect.promise(() =>
        fsp
          .stat(old)
          .then(() => true)
          .catch(() => false),
      );
      expect(stillThere).toBe(false);
    }).pipe(Effect.provide(buildLayer(home))),
  );

  it.effect("pruneAll iterates every agent and reports counts", () =>
    Effect.gen(function* () {
      const store = yield* LogStore;
      yield* store.record(recordOne("x1", "x", "2026-05-09T01:00:00.000Z"));
      yield* store.record(recordOne("x2", "x", "2026-05-09T02:00:00.000Z"));
      yield* store.record(recordOne("y1", "y", "2026-05-09T01:00:00.000Z"));
      const results = yield* store.pruneAll(1);
      const map = new Map(results.map((r) => [r.agent, r.deleted]));
      expect(map.get("x")).toBe(1);
      expect(map.get("y")).toBe(0);
    }).pipe(Effect.provide(buildLayer(home))),
  );
});
