import { Schema } from "effect";

/** Source URL or local path could not be located. */
export class SourceNotFoundError extends Schema.TaggedError<SourceNotFoundError>()(
  "SourceNotFoundError",
  { source: Schema.String, message: Schema.String },
) {}

/** Source dir is neither shape α (Pi package) nor shape β (markdown agents). */
export class InvalidShapeError extends Schema.TaggedError<InvalidShapeError>()(
  "InvalidShapeError",
  { source: Schema.String, message: Schema.String },
) {}

/** `pihub.json` was present but failed to parse or validate. */
export class ManifestParseError extends Schema.TaggedError<ManifestParseError>()(
  "ManifestParseError",
  { path: Schema.String, message: Schema.String },
) {}

/** YAML frontmatter on a markdown agent failed to parse or validate. */
export class FrontmatterParseError extends Schema.TaggedError<FrontmatterParseError>()(
  "FrontmatterParseError",
  { path: Schema.String, message: Schema.String },
) {}

/** Registry I/O or schema validation failed. */
export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  message: Schema.String,
}) {}

/** Lockfile I/O or schema validation failed. */
export class LockfileError extends Schema.TaggedError<LockfileError>()("LockfileError", {
  message: Schema.String,
}) {}

/** Source-fetcher copy failed. */
export class CopyError extends Schema.TaggedError<CopyError>()("CopyError", {
  source: Schema.String,
  dest: Schema.String,
  message: Schema.String,
}) {}

/** Profile creation failed. */
export class ProfileError extends Schema.TaggedError<ProfileError>()("ProfileError", {
  name: Schema.String,
  message: Schema.String,
}) {}

/** A remote source (github / npm) failed to fetch — outer wrapper for clone-time failures. */
export class SourceFetchError extends Schema.TaggedError<SourceFetchError>()("SourceFetchError", {
  source: Schema.String,
  message: Schema.String,
}) {}

/** A requested git ref (tag, branch, sha) does not exist on the remote. */
export class RefNotFoundError extends Schema.TaggedError<RefNotFoundError>()("RefNotFoundError", {
  repo: Schema.String,
  ref: Schema.String,
  message: Schema.String,
}) {}

/** Generic GitHub API error: HTTP failure, rate limit, or unexpected payload. */
export class GithubApiError extends Schema.TaggedError<GithubApiError>()("GithubApiError", {
  repo: Schema.String,
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

/** `git clone`/`checkout` shelled-out command failed. */
export class GitCloneError extends Schema.TaggedError<GitCloneError>()("GitCloneError", {
  url: Schema.String,
  dest: Schema.String,
  message: Schema.String,
}) {}

/** A specific npm package@version pair does not exist on the registry. */
export class NpmVersionNotFoundError extends Schema.TaggedError<NpmVersionNotFoundError>()(
  "NpmVersionNotFoundError",
  {
    packageName: Schema.String,
    version: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * `pihub install --frozen` detected drift between the resolved source state
 * and the existing lockfile (or the lockfile was missing entirely). Surfaces
 * as exit code 2 in the CLI to flag it as bad input for CI.
 */
export class FrozenDriftError extends Schema.TaggedError<FrozenDriftError>()("FrozenDriftError", {
  agentRoot: Schema.String,
  message: Schema.String,
}) {}

/** `--link` was supplied with a non-local source (github, npm, …). */
export class LinkSourceUnsupportedError extends Schema.TaggedError<LinkSourceUnsupportedError>()(
  "LinkSourceUnsupportedError",
  {
    source: Schema.String,
    message: Schema.String,
  },
) {}

/** `pihub describe <name>` lookup failed — no registry entry for that name. */
export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()(
  "AgentNotFoundError",
  {
    name: Schema.String,
    message: Schema.String,
  },
) {}
