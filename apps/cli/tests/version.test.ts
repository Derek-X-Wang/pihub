import { describe, expect, it } from "vitest";
import { CLI_VERSION } from "../src/version.js";

describe("@pihub/cli version", () => {
  it("is a non-empty semver-shaped string", () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
