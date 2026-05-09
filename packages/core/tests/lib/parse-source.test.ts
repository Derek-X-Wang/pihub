import { describe, expect, it } from "vitest";
import { isCommitSha, parseSource, pickHighestSemverTag } from "../../src/lib/parse-source.js";

describe("parseSource", () => {
  it("parses github shorthand without ref", () => {
    expect(parseSource("github:Derek-X-Wang/some-test-agent")).toEqual({
      kind: "github",
      owner: "Derek-X-Wang",
      repo: "some-test-agent",
      ref: undefined,
      normalized: "github:Derek-X-Wang/some-test-agent",
    });
  });

  it("parses github shorthand with tag ref", () => {
    expect(parseSource("github:owner/repo@v0.1.0")).toEqual({
      kind: "github",
      owner: "owner",
      repo: "repo",
      ref: "v0.1.0",
      normalized: "github:owner/repo@v0.1.0",
    });
  });

  it("parses github shorthand with branch ref", () => {
    const result = parseSource("github:owner/repo@feature/x");
    expect(result?.kind).toBe("github");
    if (result?.kind !== "github") return;
    expect(result.ref).toBe("feature/x");
  });

  it("parses https github URL with ref", () => {
    expect(parseSource("https://github.com/owner/repo@main")).toMatchObject({
      kind: "github",
      owner: "owner",
      repo: "repo",
      ref: "main",
    });
  });

  it("parses https github URL without ref and strips .git suffix", () => {
    expect(parseSource("https://github.com/owner/repo.git")).toMatchObject({
      kind: "github",
      owner: "owner",
      repo: "repo",
      ref: undefined,
    });
  });

  it("parses https github URL with trailing slash", () => {
    expect(parseSource("https://github.com/owner/repo/")).toMatchObject({
      kind: "github",
      owner: "owner",
      repo: "repo",
    });
  });

  it("parses an absolute local path", () => {
    const result = parseSource("/abs/path/agent");
    expect(result?.kind).toBe("local");
    if (result?.kind !== "local") return;
    expect(result.absolutePath).toBe("/abs/path/agent");
  });

  it("parses a ./relative path and resolves it", () => {
    const result = parseSource("./apps/cli/test/fixtures/sample-beta-agent");
    expect(result?.kind).toBe("local");
    if (result?.kind !== "local") return;
    expect(result.absolutePath.endsWith("apps/cli/test/fixtures/sample-beta-agent")).toBe(true);
  });

  it("returns null for unrecognised inputs", () => {
    expect(parseSource("git@github.com:owner/repo")).toBeNull();
    expect(parseSource("")).toBeNull();
    expect(parseSource("just-a-name")).toBeNull();
    expect(parseSource("npm:")).toBeNull();
  });

  it("parses npm shorthand without version", () => {
    expect(parseSource("npm:tiny")).toEqual({
      kind: "npm",
      packageName: "tiny",
      version: undefined,
      normalized: "npm:tiny",
    });
  });

  it("parses npm scoped package without version", () => {
    expect(parseSource("npm:@scope/pkg")).toEqual({
      kind: "npm",
      packageName: "@scope/pkg",
      version: undefined,
      normalized: "npm:@scope/pkg",
    });
  });

  it("parses npm with explicit version", () => {
    expect(parseSource("npm:pkg@1.2.3")).toMatchObject({
      kind: "npm",
      packageName: "pkg",
      version: "1.2.3",
      normalized: "npm:pkg@1.2.3",
    });
  });

  it("parses npm scoped + version, preserving the scope `@`", () => {
    expect(parseSource("npm:@mariozechner/pi-coding-agent@0.74.1")).toMatchObject({
      kind: "npm",
      packageName: "@mariozechner/pi-coding-agent",
      version: "0.74.1",
      normalized: "npm:@mariozechner/pi-coding-agent@0.74.1",
    });
  });
});

describe("isCommitSha", () => {
  it("returns true for a 40-char hex SHA", () => {
    expect(isCommitSha("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  });

  it("returns false for shorter or longer strings", () => {
    expect(isCommitSha("abc")).toBe(false);
    expect(isCommitSha("0".repeat(39))).toBe(false);
    expect(isCommitSha("0".repeat(41))).toBe(false);
  });

  it("returns false for non-hex characters", () => {
    expect(isCommitSha("g".repeat(40))).toBe(false);
  });
});

describe("pickHighestSemverTag", () => {
  it("returns null when no semver tags are present", () => {
    expect(pickHighestSemverTag(["latest", "main", "release-2024"])).toBeNull();
  });

  it("ignores non-semver tags but picks the highest matching one", () => {
    expect(pickHighestSemverTag(["v0.1.0", "v0.2.0", "stable"])).toBe("v0.2.0");
  });

  it("compares major, minor, and patch numerically rather than lexically", () => {
    expect(pickHighestSemverTag(["v1.2.3", "v1.10.0", "v1.9.9"])).toBe("v1.10.0");
    expect(pickHighestSemverTag(["v0.74.0", "v1.0.0"])).toBe("v1.0.0");
  });

  it("rejects pre-release suffixes (v1 keeps it strict)", () => {
    expect(pickHighestSemverTag(["v0.1.0-beta", "v0.1.0"])).toBe("v0.1.0");
  });
});
