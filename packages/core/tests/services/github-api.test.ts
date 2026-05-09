import { it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { GithubApi } from "../../src/services/github-api.js";

describe("GithubApi (live, mocked fetch)", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("listTags hits /repos/{owner}/{repo}/tags and decodes the array", () =>
    Effect.gen(function* () {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify([{ name: "v0.1.0" }, { name: "v0.2.0" }]), {
          status: 200,
        }),
      );
      const api = yield* GithubApi;
      const tags = yield* api.listTags("owner", "repo");
      expect(tags).toEqual(["v0.1.0", "v0.2.0"]);
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        "https://api.github.com/repos/owner/repo/tags?per_page=100",
      );
    }).pipe(Effect.provide(GithubApi.Live)),
  );

  it.effect("listTags fails with GithubApiError on 404", () =>
    Effect.gen(function* () {
      fetchSpy.mockResolvedValue(new Response("not found", { status: 404 }));
      const api = yield* GithubApi;
      const exit = yield* Effect.exit(api.listTags("owner", "repo"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("GithubApiError");
      expect(JSON.stringify(exit)).toContain("404");
    }).pipe(Effect.provide(GithubApi.Live)),
  );

  it.effect("listTags fails with GithubApiError on 403 rate limit", () =>
    Effect.gen(function* () {
      fetchSpy.mockResolvedValue(new Response("rate limit", { status: 403 }));
      const api = yield* GithubApi;
      const exit = yield* Effect.exit(api.listTags("owner", "repo"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("rate limited");
    }).pipe(Effect.provide(GithubApi.Live)),
  );

  it.effect("getDefaultBranch hits /repos/{owner}/{repo} and pulls default_branch", () =>
    Effect.gen(function* () {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ default_branch: "main" }), { status: 200 }),
      );
      const api = yield* GithubApi;
      const branch = yield* api.getDefaultBranch("owner", "repo");
      expect(branch).toBe("main");
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/owner/repo");
    }).pipe(Effect.provide(GithubApi.Live)),
  );

  it.effect("resolveCommitSha hits /repos/{owner}/{repo}/commits/{ref} and returns sha", () =>
    Effect.gen(function* () {
      fetchSpy.mockResolvedValue(new Response(JSON.stringify({ sha: "abc123" }), { status: 200 }));
      const api = yield* GithubApi;
      const sha = yield* api.resolveCommitSha("owner", "repo", "v0.1.0");
      expect(sha).toBe("abc123");
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        "https://api.github.com/repos/owner/repo/commits/v0.1.0",
      );
    }).pipe(Effect.provide(GithubApi.Live)),
  );

  it.effect("resolveCommitSha fails with RefNotFoundError on 404", () =>
    Effect.gen(function* () {
      fetchSpy.mockResolvedValue(new Response("nope", { status: 404 }));
      const api = yield* GithubApi;
      const exit = yield* Effect.exit(api.resolveCommitSha("owner", "repo", "v9.9.9"));
      expect(exit._tag).toBe("Failure");
      expect(JSON.stringify(exit)).toContain("RefNotFoundError");
    }).pipe(Effect.provide(GithubApi.Live)),
  );

  it.effect("resolveCommitSha encodes refs containing slashes (feature/x)", () =>
    Effect.gen(function* () {
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ sha: "deadbeef" }), { status: 200 }),
      );
      const api = yield* GithubApi;
      yield* api.resolveCommitSha("owner", "repo", "feature/x");
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(
        "https://api.github.com/repos/owner/repo/commits/feature%2Fx",
      );
    }).pipe(Effect.provide(GithubApi.Live)),
  );
});
