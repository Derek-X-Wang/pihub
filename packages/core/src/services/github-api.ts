import { Context, Effect, Layer, Ref } from "effect";
import { GithubApiError, RefNotFoundError } from "../errors.js";

const API_BASE = "https://api.github.com";

const headers = (): Record<string, string> => {
  const h: Record<string, string> = { Accept: "application/vnd.github.v3+json" };
  const token = process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
};

export interface GithubApiShape {
  /** GET /repos/{owner}/{repo}/tags — returns tag names. */
  readonly listTags: (
    owner: string,
    repo: string,
  ) => Effect.Effect<readonly string[], GithubApiError>;
  /** GET /repos/{owner}/{repo} — returns the default branch name. */
  readonly getDefaultBranch: (owner: string, repo: string) => Effect.Effect<string, GithubApiError>;
  /** GET /repos/{owner}/{repo}/commits/{ref} — returns the resolved 40-char commit SHA. */
  readonly resolveCommitSha: (
    owner: string,
    repo: string,
    ref: string,
  ) => Effect.Effect<string, GithubApiError | RefNotFoundError>;
}

const repoLabel = (owner: string, repo: string) => `${owner}/${repo}`;

const decodeJson = <T>(res: Response, repo: string): Effect.Effect<T, GithubApiError> =>
  Effect.tryPromise({
    try: () => res.json() as Promise<T>,
    catch: (e) =>
      new GithubApiError({
        repo,
        message: `failed to decode JSON: ${String(e)}`,
        status: res.status,
      }),
  });

export class GithubApi extends Context.Tag("GithubApi")<GithubApi, GithubApiShape>() {
  static readonly Live = Layer.succeed(GithubApi, {
    listTags: (owner, repo) =>
      Effect.gen(function* () {
        const url = `${API_BASE}/repos/${owner}/${repo}/tags?per_page=100`;
        const res = yield* Effect.tryPromise({
          try: () => fetch(url, { headers: headers() }),
          catch: (e) =>
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: `tags fetch threw: ${String(e)}`,
            }),
        });
        if (res.status === 404) {
          return yield* Effect.fail(
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: "repo not found",
              status: 404,
            }),
          );
        }
        if (res.status === 403) {
          return yield* Effect.fail(
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: "rate limited or forbidden",
              status: 403,
            }),
          );
        }
        if (!res.ok) {
          return yield* Effect.fail(
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: `GET /tags failed: ${res.status} ${res.statusText}`,
              status: res.status,
            }),
          );
        }
        const body = yield* decodeJson<Array<{ name?: unknown }>>(res, repoLabel(owner, repo));
        if (!Array.isArray(body)) {
          return yield* Effect.fail(
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: "tags response is not an array",
              status: res.status,
            }),
          );
        }
        return body
          .map((t) => (typeof t.name === "string" ? t.name : ""))
          .filter((s) => s.length > 0);
      }),

    getDefaultBranch: (owner, repo) =>
      Effect.gen(function* () {
        const url = `${API_BASE}/repos/${owner}/${repo}`;
        const res = yield* Effect.tryPromise({
          try: () => fetch(url, { headers: headers() }),
          catch: (e) =>
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: `repo fetch threw: ${String(e)}`,
            }),
        });
        if (!res.ok) {
          return yield* Effect.fail(
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: `GET /repos failed: ${res.status} ${res.statusText}`,
              status: res.status,
            }),
          );
        }
        const body = yield* decodeJson<{ default_branch?: unknown }>(res, repoLabel(owner, repo));
        if (typeof body.default_branch !== "string" || body.default_branch.length === 0) {
          return yield* Effect.fail(
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: "missing default_branch in repo response",
              status: res.status,
            }),
          );
        }
        return body.default_branch;
      }),

    resolveCommitSha: (owner, repo, ref) =>
      Effect.gen(function* () {
        const url = `${API_BASE}/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
        const res = yield* Effect.tryPromise({
          try: () => fetch(url, { headers: headers() }),
          catch: (e) =>
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: `commits fetch threw: ${String(e)}`,
            }),
        });
        if (res.status === 404 || res.status === 422) {
          return yield* Effect.fail(
            new RefNotFoundError({
              repo: repoLabel(owner, repo),
              ref,
              message: `ref not found on remote (${res.status})`,
            }),
          );
        }
        if (!res.ok) {
          return yield* Effect.fail(
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: `GET /commits failed: ${res.status} ${res.statusText}`,
              status: res.status,
            }),
          );
        }
        const body = yield* decodeJson<{ sha?: unknown }>(res, repoLabel(owner, repo));
        if (typeof body.sha !== "string" || body.sha.length === 0) {
          return yield* Effect.fail(
            new GithubApiError({
              repo: repoLabel(owner, repo),
              message: "missing sha in commits response",
              status: res.status,
            }),
          );
        }
        return body.sha;
      }),
  });

  /**
   * Test layer with three Ref-backed maps: tags by `<owner>/<repo>`,
   * default-branch by repo, and commit SHAs keyed `<owner>/<repo>@<ref>`.
   */
  static readonly Test = (
    seed: {
      readonly tags?: ReadonlyMap<string, ReadonlyArray<string>>;
      readonly defaultBranch?: ReadonlyMap<string, string>;
      readonly commits?: ReadonlyMap<string, string>;
    } = {},
  ) =>
    Layer.effect(
      GithubApi,
      Effect.gen(function* () {
        const tags = yield* Ref.make(new Map(seed.tags ?? new Map()));
        const branches = yield* Ref.make(new Map(seed.defaultBranch ?? new Map()));
        const commits = yield* Ref.make(new Map(seed.commits ?? new Map()));
        const key = (owner: string, repo: string, ref?: string) =>
          ref ? `${owner}/${repo}@${ref}` : `${owner}/${repo}`;
        return {
          listTags: (owner, repo) =>
            Ref.get(tags).pipe(Effect.map((m) => m.get(key(owner, repo)) ?? [])),
          getDefaultBranch: (owner, repo) =>
            Effect.gen(function* () {
              const m = yield* Ref.get(branches);
              const v = m.get(key(owner, repo));
              if (!v) {
                return yield* Effect.fail(
                  new GithubApiError({
                    repo: repoLabel(owner, repo),
                    message: "no default branch seeded for this repo in Test layer",
                  }),
                );
              }
              return v;
            }),
          resolveCommitSha: (owner, repo, ref) =>
            Effect.gen(function* () {
              const m = yield* Ref.get(commits);
              const v = m.get(key(owner, repo, ref));
              if (!v) {
                return yield* Effect.fail(
                  new RefNotFoundError({
                    repo: repoLabel(owner, repo),
                    ref,
                    message: "no commit SHA seeded for this ref in Test layer",
                  }),
                );
              }
              return v;
            }),
        } satisfies GithubApiShape;
      }),
    );
}
