import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { ShapeDetector } from "../../src/services/shape-detector.js";

const provideLive = <A, E>(eff: Effect.Effect<A, E, ShapeDetector>) =>
  eff.pipe(Effect.provide(ShapeDetector.Live), Effect.provide(BunContext.layer));

describe("ShapeDetector (live, real FS)", () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "pihub-shape-"));
  });

  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it.effect("detects shape β with a single markdown agent", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fsp.mkdir(path.join(tmp, "agents"), { recursive: true }));
      yield* Effect.promise(() =>
        fsp.writeFile(
          path.join(tmp, "agents", "scout.md"),
          [
            "---",
            "name: scout",
            "description: fast codebase recon",
            "tools: read, grep",
            "model: claude-sonnet-4",
            "---",
            "",
            "agent body",
            "",
          ].join("\n"),
        ),
      );

      const detector = yield* ShapeDetector;
      const result = yield* detector.detect(tmp);
      expect(result.kind).toBe("beta");
      if (result.kind !== "beta") return;
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]?.subName).toBe("scout");
      expect(result.agents[0]?.description).toBe("fast codebase recon");
    }).pipe(provideLive),
  );

  it.effect("detects shape β with multiple markdown agents, sorted", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fsp.mkdir(path.join(tmp, "agents"), { recursive: true }));
      yield* Effect.promise(() =>
        fsp.writeFile(
          path.join(tmp, "agents", "planner.md"),
          ["---", "name: planner", "description: writes plans", "---", ""].join("\n"),
        ),
      );
      yield* Effect.promise(() =>
        fsp.writeFile(
          path.join(tmp, "agents", "scout.md"),
          ["---", "name: scout", "description: scouts", "---", ""].join("\n"),
        ),
      );

      const detector = yield* ShapeDetector;
      const result = yield* detector.detect(tmp);
      expect(result.kind).toBe("beta");
      if (result.kind !== "beta") return;
      const names = result.agents.map((a) => a.subName);
      expect(names).toEqual(["planner", "scout"]);
    }).pipe(provideLive),
  );

  it.effect("rejects markdown without frontmatter as FrontmatterParseError", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fsp.mkdir(path.join(tmp, "agents"), { recursive: true }));
      yield* Effect.promise(() =>
        fsp.writeFile(path.join(tmp, "agents", "broken.md"), "no frontmatter here\n"),
      );

      const detector = yield* ShapeDetector;
      const exit = yield* Effect.exit(detector.detect(tmp));
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(JSON.stringify(exit.cause)).toContain("FrontmatterParseError");
      }
    }).pipe(provideLive),
  );

  it.effect("rejects malformed YAML in frontmatter", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => fsp.mkdir(path.join(tmp, "agents"), { recursive: true }));
      yield* Effect.promise(() =>
        fsp.writeFile(
          path.join(tmp, "agents", "bad.md"),
          ["---", "name: scout", "tools: [unterminated", "---", ""].join("\n"),
        ),
      );

      const detector = yield* ShapeDetector;
      const exit = yield* Effect.exit(detector.detect(tmp));
      expect(exit._tag).toBe("Failure");
    }).pipe(provideLive),
  );

  it.effect("rejects when there is no agents/ directory", () =>
    Effect.gen(function* () {
      const detector = yield* ShapeDetector;
      const exit = yield* Effect.exit(detector.detect(tmp));
      expect(exit._tag).toBe("Failure");
    }).pipe(provideLive),
  );
});
