import { BunContext } from "@effect/platform-bun";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";
import { GitClient } from "../../src/services/git-client.js";
import { GithubApi } from "../../src/services/github-api.js";
import { SourceFetcher } from "../../src/services/source-fetcher.js";

const SHA_TAG = "1111111111111111111111111111111111111111";
const SHA_BRANCH = "2222222222222222222222222222222222222222";
const SHA_DEFAULT = "3333333333333333333333333333333333333333";
const SHA_DIRECT = "0123456789abcdef0123456789abcdef01234567";

const buildLayer = (api: ReturnType<typeof GithubApi.Test>) =>
  SourceFetcher.Live.pipe(Layer.provide(Layer.mergeAll(api, GitClient.Test(), BunContext.layer)));

describe("SourceFetcher (github branch, faked GithubApi + GitClient)", () => {
  it.effect("ref form: tag — github:owner/repo@v0.1.0 records tag SHA", () =>
    Effect.gen(function* () {
      const fetcher = yield* SourceFetcher;
      const info = yield* fetcher.fetch("github:owner/repo@v0.1.0", "/tmp/dest");
      expect(info.commitSha).toBe(SHA_TAG);
      expect(info.ref).toBe("v0.1.0");
      expect(info.source).toBe("github:owner/repo@v0.1.0");
    }).pipe(
      Effect.provide(
        buildLayer(
          GithubApi.Test({
            commits: new Map([["owner/repo@v0.1.0", SHA_TAG]]),
          }),
        ),
      ),
    ),
  );

  it.effect("ref form: branch — github:owner/repo@main resolves through commits API", () =>
    Effect.gen(function* () {
      const fetcher = yield* SourceFetcher;
      const info = yield* fetcher.fetch("github:owner/repo@main", "/tmp/dest");
      expect(info.commitSha).toBe(SHA_BRANCH);
      expect(info.ref).toBe("main");
    }).pipe(
      Effect.provide(
        buildLayer(
          GithubApi.Test({
            commits: new Map([["owner/repo@main", SHA_BRANCH]]),
          }),
        ),
      ),
    ),
  );

  it.effect("ref form: 40-char SHA — bypasses commits API, uses ref verbatim", () =>
    Effect.gen(function* () {
      // No `commits` seeded, but a 40-char SHA must be treated as the commit
      // identity directly. If the fetcher tried to resolve it through the
      // GithubApi.Test layer the call would fail with RefNotFoundError.
      const fetcher = yield* SourceFetcher;
      const info = yield* fetcher.fetch(`github:owner/repo@${SHA_DIRECT}`, "/tmp/dest");
      expect(info.commitSha).toBe(SHA_DIRECT);
      expect(info.ref).toBe(SHA_DIRECT);
    }).pipe(Effect.provide(buildLayer(GithubApi.Test()))),
  );

  it.effect("ref form: none — picks highest semver tag via listTags, then resolves SHA", () =>
    Effect.gen(function* () {
      const fetcher = yield* SourceFetcher;
      const info = yield* fetcher.fetch("github:owner/repo", "/tmp/dest");
      expect(info.commitSha).toBe(SHA_TAG);
      expect(info.ref).toBe("v0.2.0");
      expect(info.source).toBe("github:owner/repo");
    }).pipe(
      Effect.provide(
        buildLayer(
          GithubApi.Test({
            tags: new Map([["owner/repo", ["v0.1.0", "v0.2.0", "stable"]]]),
            commits: new Map([["owner/repo@v0.2.0", SHA_TAG]]),
          }),
        ),
      ),
    ),
  );

  it.effect("ref form: none, no semver tags — falls back to default branch + resolves SHA", () =>
    Effect.gen(function* () {
      const fetcher = yield* SourceFetcher;
      const info = yield* fetcher.fetch("github:owner/repo", "/tmp/dest");
      expect(info.commitSha).toBe(SHA_DEFAULT);
      expect(info.ref).toBe("main");
    }).pipe(
      Effect.provide(
        buildLayer(
          GithubApi.Test({
            tags: new Map([["owner/repo", ["release-2024", "stable"]]]),
            defaultBranch: new Map([["owner/repo", "main"]]),
            commits: new Map([["owner/repo@main", SHA_DEFAULT]]),
          }),
        ),
      ),
    ),
  );

  it.effect("https URL form is treated identically to github: shorthand", () =>
    Effect.gen(function* () {
      const fetcher = yield* SourceFetcher;
      const info = yield* fetcher.fetch("https://github.com/owner/repo@v0.1.0", "/tmp/dest");
      expect(info.commitSha).toBe(SHA_TAG);
      expect(info.ref).toBe("v0.1.0");
      // Normalised back to canonical github: form for stable lockfile keys.
      expect(info.source).toBe("github:owner/repo@v0.1.0");
    }).pipe(
      Effect.provide(
        buildLayer(
          GithubApi.Test({
            commits: new Map([["owner/repo@v0.1.0", SHA_TAG]]),
          }),
        ),
      ),
    ),
  );

  it.effect("unrecognised source surfaces as SourceNotFoundError", () =>
    Effect.gen(function* () {
      const fetcher = yield* SourceFetcher;
      const exit = yield* Effect.exit(fetcher.fetch("git@github.com:owner/repo", "/tmp/dest"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("SourceNotFoundError");
    }).pipe(Effect.provide(buildLayer(GithubApi.Test()))),
  );
});
