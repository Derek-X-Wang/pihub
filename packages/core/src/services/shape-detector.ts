import { FileSystem } from "@effect/platform";
import { BetaAgentFrontmatter } from "@pihub/schema";
import { Context, Effect, Layer, Ref, Schema } from "effect";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { FrontmatterParseError, InvalidShapeError } from "../errors.js";
import type { BetaAgentInfo, DetectionResult } from "../types.js";

const decodeFrontmatter = Schema.decodeUnknown(BetaAgentFrontmatter);

export interface ShapeDetectorShape {
  readonly detect: (
    sourceDir: string,
  ) => Effect.Effect<DetectionResult, InvalidShapeError | FrontmatterParseError>;
}

const FRONTMATTER_OPEN = "---";

/**
 * Pull YAML frontmatter from a markdown string. Mirrors pi-mono's
 * `parseFrontmatter` so both projects accept the same input shape.
 */
const extractYaml = (content: string): string | null => {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith(FRONTMATTER_OPEN)) return null;
  const closeIndex = normalized.indexOf(`\n${FRONTMATTER_OPEN}`, FRONTMATTER_OPEN.length);
  if (closeIndex === -1) return null;
  return normalized.slice(FRONTMATTER_OPEN.length + 1, closeIndex);
};

const parseAgentMd = (
  filePath: string,
  content: string,
): Effect.Effect<BetaAgentInfo, FrontmatterParseError> =>
  Effect.gen(function* () {
    const yaml = extractYaml(content);
    if (yaml === null) {
      return yield* Effect.fail(
        new FrontmatterParseError({
          path: filePath,
          message: "missing or unterminated YAML frontmatter",
        }),
      );
    }
    const raw = yield* Effect.try({
      try: () => parseYaml(yaml),
      catch: (e) =>
        new FrontmatterParseError({
          path: filePath,
          message: `YAML parse failed: ${String(e)}`,
        }),
    });
    const decoded = yield* decodeFrontmatter(raw ?? {}).pipe(
      Effect.mapError(
        (e) =>
          new FrontmatterParseError({
            path: filePath,
            message: `frontmatter schema validation failed: ${e.message}`,
          }),
      ),
    );
    return {
      subName: decoded.name,
      description: decoded.description ?? "",
      mdPath: path.relative(path.dirname(path.dirname(filePath)), filePath),
    };
  });

/**
 * Try shape α first: read `package.json` and look for the `pi` field. The
 * caller falls back to β detection only if this returns `null` (no
 * package.json or no `pi` field). Per CONTEXT.md "Detection rules", α wins
 * over β when both are present.
 */
const tryAlpha = (
  fs: FileSystem.FileSystem,
  sourceDir: string,
): Effect.Effect<DetectionResult | null, InvalidShapeError> =>
  Effect.gen(function* () {
    const pkgPath = path.join(sourceDir, "package.json");
    const exists = yield* fs.exists(pkgPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) return null;
    const raw = yield* fs.readFileString(pkgPath).pipe(
      Effect.mapError(
        (e) =>
          new InvalidShapeError({
            source: sourceDir,
            message: `failed to read package.json: ${String(e)}`,
          }),
      ),
    );
    const parsed = yield* Effect.try({
      try: () => JSON.parse(raw) as Record<string, unknown>,
      catch: (e) =>
        new InvalidShapeError({
          source: sourceDir,
          message: `failed to parse package.json: ${String(e)}`,
        }),
    });
    const piField = parsed["pi"];
    if (typeof piField !== "object" || piField === null) return null;
    const piObj = piField as Record<string, unknown>;
    const packageName = typeof parsed["name"] === "string" ? parsed["name"] : "";
    if (packageName.length === 0) {
      return yield* Effect.fail(
        new InvalidShapeError({
          source: sourceDir,
          message: "package.json has `pi` field but no `name`",
        }),
      );
    }
    const piDescription =
      typeof piObj["description"] === "string" ? (piObj["description"] as string) : undefined;
    const pkgDescription =
      typeof parsed["description"] === "string" ? (parsed["description"] as string) : undefined;
    const description = piDescription ?? pkgDescription ?? "";
    const deps = parsed["dependencies"];
    const piRange =
      typeof deps === "object" && deps !== null
        ? typeof (deps as Record<string, unknown>)["@mariozechner/pi-coding-agent"] === "string"
          ? ((deps as Record<string, string>)["@mariozechner/pi-coding-agent"] as string)
          : undefined
        : undefined;
    return {
      kind: "alpha",
      info: { packageName, description, piRange },
    } satisfies DetectionResult;
  });

const detectBeta = (
  fs: FileSystem.FileSystem,
  sourceDir: string,
): Effect.Effect<DetectionResult, InvalidShapeError | FrontmatterParseError> =>
  Effect.gen(function* () {
    const agentsDir = path.join(sourceDir, "agents");
    const exists = yield* fs.exists(agentsDir).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return yield* Effect.fail(
        new InvalidShapeError({
          source: sourceDir,
          message: "no `agents/` directory and no `package.json` `pi` field detected",
        }),
      );
    }
    const entries = yield* fs.readDirectory(agentsDir).pipe(
      Effect.mapError(
        (e) =>
          new InvalidShapeError({
            source: sourceDir,
            message: `failed to read agents/ directory: ${String(e)}`,
          }),
      ),
    );
    const mdFiles = entries.filter((e) => e.endsWith(".md")).sort();
    if (mdFiles.length === 0) {
      return yield* Effect.fail(
        new InvalidShapeError({
          source: sourceDir,
          message: "agents/ directory contains no `.md` files",
        }),
      );
    }
    const agents: BetaAgentInfo[] = [];
    for (const md of mdFiles) {
      const filePath = path.join(agentsDir, md);
      const content = yield* fs.readFileString(filePath).pipe(
        Effect.mapError(
          (e) =>
            new FrontmatterParseError({
              path: filePath,
              message: `failed to read markdown file: ${String(e)}`,
            }),
        ),
      );
      agents.push(yield* parseAgentMd(filePath, content));
    }
    return { kind: "beta", agents };
  });

export class ShapeDetector extends Context.Tag("ShapeDetector")<
  ShapeDetector,
  ShapeDetectorShape
>() {
  static readonly Live = Layer.effect(
    ShapeDetector,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ShapeDetector.of({
        detect: (sourceDir) =>
          Effect.gen(function* () {
            const alpha = yield* tryAlpha(fs, sourceDir);
            if (alpha) return alpha;
            return yield* detectBeta(fs, sourceDir);
          }),
      });
    }),
  );

  /**
   * Test layer with a configurable canned-answer Map. Use the `*` key as a
   * wildcard fallback when tests can't predict the source path (e.g. random
   * tempdirs from `pihub update --dry-run`). Default behaviour: any
   * unrecognised path fails with `InvalidShapeError` so tests must explicitly
   * seed expectations.
   */
  static readonly Test = (seed: ReadonlyMap<string, DetectionResult> = new Map()) =>
    Layer.effect(
      ShapeDetector,
      Effect.gen(function* () {
        const store = yield* Ref.make(new Map(seed));
        return ShapeDetector.of({
          detect: (sourceDir) =>
            Effect.gen(function* () {
              const map = yield* Ref.get(store);
              const hit = map.get(sourceDir) ?? map.get("*");
              if (!hit) {
                return yield* Effect.fail(
                  new InvalidShapeError({
                    source: sourceDir,
                    message: "no canned detection result for this path in Test layer",
                  }),
                );
              }
              return hit;
            }),
        });
      }),
    );
}
