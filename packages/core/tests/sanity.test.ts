import { describe, expect, it } from "vitest";
import { PIHUB_CORE_VERSION } from "../src/index.js";

describe("@pihub/core", () => {
  it("exports a version constant", () => {
    expect(PIHUB_CORE_VERSION).toBe("0.0.0");
  });
});
