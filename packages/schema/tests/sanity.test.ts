import { describe, expect, it } from "vitest";
import { PIHUB_SCHEMA_VERSION } from "../src/index.js";

describe("@pihub/schema", () => {
  it("exports a version constant", () => {
    expect(PIHUB_SCHEMA_VERSION).toBe("0.0.0");
  });
});
