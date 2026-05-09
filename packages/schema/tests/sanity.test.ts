import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  BetaAgentFrontmatter,
  Lockfile,
  Manifest,
  PIHUB_SCHEMA_VERSION,
  Registry,
  RegistryEntry,
  emptyManifest,
  emptyRegistry,
} from "../src/index.js";

describe("@pihub/schema", () => {
  it("exports a version constant", () => {
    expect(PIHUB_SCHEMA_VERSION).toBe("0.0.0");
  });

  it("Manifest accepts an empty object (all fields optional)", () => {
    const decoded = Effect.runSync(Schema.decodeUnknown(Manifest)({}));
    expect(decoded).toEqual({});
  });

  it("Manifest rejects an unknown runtime value", () => {
    const result = Effect.runSyncExit(Schema.decodeUnknown(Manifest)({ runtime: "claude-code" }));
    expect(result._tag).toBe("Failure");
  });

  it("Manifest accepts the canonical Pi shape with all fields", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknown(Manifest)({
        name: "foo/bar",
        description: "hello",
        version: "0.3.0",
        runtime: "pi",
        tags: ["recon"],
        env: ["ANTHROPIC_API_KEY"],
        permissions: ["read"],
        timeoutSeconds: 600,
      }),
    );
    expect(decoded.runtime).toBe("pi");
    expect(decoded.timeoutSeconds).toBe(600);
  });

  it("emptyManifest is a valid Manifest", () => {
    const decoded = Effect.runSync(Schema.decodeUnknown(Manifest)(emptyManifest));
    expect(decoded).toEqual({});
  });

  it("Lockfile requires every field and defaults link=false", () => {
    const lock: Lockfile = {
      source: "./fixtures/foo",
      ref: "tree-abc",
      commitSha: "abc",
      piSlot: "0.74",
      depsLockSha: "",
      installedAt: "2026-05-09T00:00:00.000Z",
      link: false,
    };
    const decoded = Effect.runSync(Schema.decodeUnknown(Lockfile)(lock));
    expect(decoded.source).toBe("./fixtures/foo");
    expect(decoded.link).toBe(false);
  });

  it("Lockfile decodes legacy v0 entries with no `link` field", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknown(Lockfile)({
        source: "/abs/legacy",
        ref: "tree-abc",
        commitSha: "abc",
        piSlot: "default",
        depsLockSha: "",
        installedAt: "2026-05-09T00:00:00.000Z",
      }),
    );
    expect(decoded.link).toBe(false);
  });

  it("Registry seeds an empty agents list", () => {
    const decoded = Effect.runSync(Schema.decodeUnknown(Registry)(emptyRegistry));
    expect(decoded.agents).toEqual([]);
  });

  it("RegistryEntry encodes a shape-β agent name with sub", () => {
    const entry: RegistryEntry = {
      name: "sample-beta-agent:scout",
      shape: "beta",
      piSlot: "0.74",
      source: "/abs/path",
      ref: "tree-abc",
      commitSha: "abc",
      description: "scout the codebase",
      invoke: 'pihub invoke sample-beta-agent:scout "<task>"',
      envDeclared: [],
      linked: false,
    };
    const decoded = Effect.runSync(Schema.decodeUnknown(RegistryEntry)(entry));
    expect(decoded.shape).toBe("beta");
  });

  it("BetaAgentFrontmatter accepts both string and array tools", () => {
    const stringTools = Effect.runSync(
      Schema.decodeUnknown(BetaAgentFrontmatter)({
        name: "scout",
        tools: "read, grep, find",
      }),
    );
    expect(stringTools.tools).toBe("read, grep, find");

    const arrayTools = Effect.runSync(
      Schema.decodeUnknown(BetaAgentFrontmatter)({
        name: "planner",
        tools: ["read", "grep"],
      }),
    );
    expect(arrayTools.tools).toEqual(["read", "grep"]);
  });

  it("BetaAgentFrontmatter rejects empty name", () => {
    const result = Effect.runSyncExit(Schema.decodeUnknown(BetaAgentFrontmatter)({ name: "" }));
    expect(result._tag).toBe("Failure");
  });
});
