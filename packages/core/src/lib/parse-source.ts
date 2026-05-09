import * as path from "node:path";

/**
 * Discriminated union over the v1 source URL kinds: local path, github clone,
 * and npm package. Future kinds (gitlab, bitbucket, ssh) come post-v1 — see
 * CONTEXT.md "Source URL kinds".
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
    }
  | {
      readonly kind: "npm";
      /** Full package name including scope when present, e.g. `@mariozechner/pi-coding-agent`. */
      readonly packageName: string;
      readonly version: string | undefined;
      /** Canonical normalised form, e.g. `npm:pkg` or `npm:@scope/pkg@1.0.0`. */
      readonly normalized: string;
    };

const GH_SHORTHAND = /^github:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:@([^\s]+))?$/;
const GH_HTTPS =
  /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?(?:@([^\s]+))?$/;
const NPM_PREFIX = /^npm:(.+)$/;
const NPM_PACKAGE_NAME = /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/;

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
 * Splits an `npm:` payload into package name + optional version. Scoped
 * packages start with `@`, so the version separator is the *last* `@` whose
 * index is greater than zero. `@scope/pkg` therefore returns no version,
 * while `pkg@1.0.0` and `@scope/pkg@1.0.0` both yield the trailing version.
 */
const splitNpm = (payload: string): { packageName: string; version: string | undefined } | null => {
  const lastAt = payload.lastIndexOf("@");
  if (lastAt > 0) {
    const packageName = payload.slice(0, lastAt);
    const version = payload.slice(lastAt + 1);
    if (!NPM_PACKAGE_NAME.test(packageName) || version.length === 0) return null;
    return { packageName, version };
  }
  if (!NPM_PACKAGE_NAME.test(payload)) return null;
  return { packageName: payload, version: undefined };
};

const buildNpm = (
  packageName: string,
  version: string | undefined,
): Extract<ParsedSource, { kind: "npm" }> => ({
  kind: "npm",
  packageName,
  version,
  normalized: `npm:${packageName}${version ? `@${version}` : ""}`,
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

  const m3 = NPM_PREFIX.exec(trimmed);
  if (m3) {
    const split = splitNpm(m3[1] as string);
    if (split) return buildNpm(split.packageName, split.version);
    return null;
  }

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
 * Best-effort extraction of `<major>.<minor>` from a semver range string. Used
 * to map `dependencies["@mariozechner/pi-coding-agent"]` (e.g. `^0.74.0`,
 * `~0.74.1`, `>=0.74.0 <0.75.0`) into a runtime-slot directory name. Returns
 * null if no `MAJOR.MINOR.PATCH` triple is found.
 */
export const extractPiMinor = (range: string): string | null => {
  const m = /(\d+)\.(\d+)\.\d+/.exec(range);
  if (!m) return null;
  return `${m[1]}.${m[2]}`;
};

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
