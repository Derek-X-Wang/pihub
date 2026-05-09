import * as path from "node:path";

/**
 * Discriminated union over the v1 source URL kinds. Slice #5 adds an `npm`
 * variant; slice #4 ships only `local` and `github`.
 */
export type ParsedSource =
  | { readonly kind: "local"; readonly absolutePath: string }
  | {
      readonly kind: "github";
      readonly owner: string;
      readonly repo: string;
      readonly ref: string | undefined;
      /** Canonical normalised form, e.g. `github:owner/repo` or `github:owner/repo@v0.3.0`. */
      readonly normalized: string;
    };

const GH_SHORTHAND = /^github:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:@([^\s]+))?$/;
const GH_HTTPS =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?(?:@([^\s]+))?$/;

const buildGithub = (
  owner: string,
  repo: string,
  ref: string | undefined,
): Extract<ParsedSource, { kind: "github" }> => ({
  kind: "github",
  owner,
  repo,
  ref,
  normalized: `github:${owner}/${repo}${ref ? `@${ref}` : ""}`,
});

/**
 * Parse a CLI source argument into a typed shape. Returns `null` when the
 * input matches no supported URL kind — callers convert that to a
 * `SourceNotFoundError` with a helpful message listing the supported kinds.
 */
export const parseSource = (raw: string): ParsedSource | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const m1 = GH_SHORTHAND.exec(trimmed);
  if (m1) return buildGithub(m1[1] as string, m1[2] as string, m1[3]);

  const m2 = GH_HTTPS.exec(trimmed);
  if (m2) return buildGithub(m2[1] as string, m2[2] as string, m2[3]);

  if (
    trimmed === "." ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    path.isAbsolute(trimmed)
  ) {
    return { kind: "local", absolutePath: path.resolve(trimmed) };
  }

  return null;
};

/** Returns true iff `ref` looks like a 40-character hex commit SHA. */
export const isCommitSha = (ref: string): boolean => /^[0-9a-f]{40}$/.test(ref);

/**
 * Best-effort semver tag picker. Accepts `vMAJOR.MINOR.PATCH` (without
 * pre-release/build), returns the highest. Returns `null` if no tag matches.
 */
const SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

export const pickHighestSemverTag = (tags: ReadonlyArray<string>): string | null => {
  const parsed: Array<{ tag: string; major: number; minor: number; patch: number }> = [];
  for (const t of tags) {
    const m = SEMVER_TAG.exec(t);
    if (!m) continue;
    parsed.push({
      tag: t,
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
    });
  }
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => {
    if (a.major !== b.major) return b.major - a.major;
    if (a.minor !== b.minor) return b.minor - a.minor;
    return b.patch - a.patch;
  });
  return (parsed[0] as { tag: string }).tag;
};
