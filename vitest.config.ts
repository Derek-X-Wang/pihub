import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/tests/**/*.test.ts", "packages/**/tests/**/*.test.ts"],
    // Some tests spawn faux-pi shell scripts that hold a SIGINT for a few
    // seconds before exiting (timeout/abort coverage). Bump beyond the 5s
    // default so CI doesn't flake.
    testTimeout: 20_000,
  },
});
