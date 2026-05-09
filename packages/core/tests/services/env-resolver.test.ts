import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Paths } from "../../src/paths.js";
import { EnvResolver } from "../../src/services/env-resolver.js";
import { EnvStore } from "../../src/services/env-store.js";

const TEST_HOME = "/tmp/.pihub-env-test";

const buildLayer = (
  globalEnv: Record<string, string>,
  agentEnv: Record<string, string>,
  agentName: string,
) => {
  const paths = Paths.Test(TEST_HOME);
  // Reach into the Paths layer for the literal paths so the EnvStore.Test
  // seed keys match what EnvResolver.Live will read.
  const globalPath = `${TEST_HOME}/env`;
  const agentPath = `${TEST_HOME}/agents/${agentName}/env`;
  const store = EnvStore.Test(
    new Map([
      [globalPath, globalEnv],
      [agentPath, agentEnv],
    ]),
  );
  return EnvResolver.Live.pipe(Layer.provide(Layer.mergeAll(paths, store)));
};

describe("EnvResolver layered precedence", () => {
  // Snapshot + restore process.env so tests can assert shell-tier behaviour.
  const original: Record<string, string | undefined> = {};
  const KEYS = ["A_KEY", "B_KEY", "SHELL_ONLY", "ANTHROPIC_API_KEY"];

  beforeEach(() => {
    for (const k of KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      const v = original[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it.effect("global only → returned verbatim", () =>
    Effect.gen(function* () {
      const r = yield* EnvResolver;
      const env = yield* r.resolve("agent", undefined);
      expect(env["A_KEY"]).toBe("from-global");
    }).pipe(Effect.provide(buildLayer({ A_KEY: "from-global" }, {}, "agent"))),
  );

  it.effect("per-agent file overrides global", () =>
    Effect.gen(function* () {
      const r = yield* EnvResolver;
      const env = yield* r.resolve("agent", undefined);
      expect(env["A_KEY"]).toBe("from-agent");
    }).pipe(Effect.provide(buildLayer({ A_KEY: "from-global" }, { A_KEY: "from-agent" }, "agent"))),
  );

  it.effect("shell process.env overrides per-agent", () =>
    Effect.gen(function* () {
      process.env["A_KEY"] = "from-shell";
      const r = yield* EnvResolver;
      const env = yield* r.resolve("agent", undefined);
      expect(env["A_KEY"]).toBe("from-shell");
    }).pipe(Effect.provide(buildLayer({ A_KEY: "from-global" }, { A_KEY: "from-agent" }, "agent"))),
  );

  it.effect("manifest allowlist filters output", () =>
    Effect.gen(function* () {
      const r = yield* EnvResolver;
      const env = yield* r.resolve("agent", ["A_KEY"]);
      expect(env["A_KEY"]).toBe("from-agent");
      expect(env["B_KEY"]).toBeUndefined();
    }).pipe(
      Effect.provide(
        buildLayer({ B_KEY: "global-b" }, { A_KEY: "from-agent", B_KEY: "agent-b" }, "agent"),
      ),
    ),
  );

  it.effect("undefined allowlist passes everything through", () =>
    Effect.gen(function* () {
      process.env["SHELL_ONLY"] = "shell";
      const r = yield* EnvResolver;
      const env = yield* r.resolve("agent", undefined);
      expect(env["A_KEY"]).toBe("from-agent");
      expect(env["B_KEY"]).toBe("global-b");
      expect(env["SHELL_ONLY"]).toBe("shell");
    }).pipe(Effect.provide(buildLayer({ B_KEY: "global-b" }, { A_KEY: "from-agent" }, "agent"))),
  );

  it.effect("empty allowlist returns nothing — strict mode", () =>
    Effect.gen(function* () {
      const r = yield* EnvResolver;
      const env = yield* r.resolve("agent", []);
      expect(Object.keys(env)).toHaveLength(0);
    }).pipe(Effect.provide(buildLayer({ A_KEY: "global" }, { A_KEY: "agent" }, "agent"))),
  );
});
