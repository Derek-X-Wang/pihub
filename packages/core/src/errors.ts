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

/** Pi runtime slot install or resolution failed. */
export class RuntimeSlotError extends Schema.TaggedError<RuntimeSlotError>()("RuntimeSlotError", {
  slot: Schema.String,
  message: Schema.String,
}) {}

/** `bun install` invoked for a runtime slot returned non-zero. */
export class BunInstallError extends Schema.TaggedError<BunInstallError>()("BunInstallError", {
  cwd: Schema.String,
  dep: Schema.String,
  message: Schema.String,
}) {}

/** `pi` subprocess invocation failed before producing any output. */
export class InvokeSpawnError extends Schema.TaggedError<InvokeSpawnError>()("InvokeSpawnError", {
  binary: Schema.String,
  message: Schema.String,
}) {}

/** `pi --mode json` produced output that did not parse as a JSONL event stream. */
export class InvokeOutputError extends Schema.TaggedError<InvokeOutputError>()(
  "InvokeOutputError",
  {
    message: Schema.String,
  },
) {}

/** `pi install` (slice #9 shape-α profile install) returned non-zero. */
export class PiInstallError extends Schema.TaggedError<PiInstallError>()("PiInstallError", {
  binary: Schema.String,
  source: Schema.String,
  profile: Schema.String,
  message: Schema.String,
}) {}

/** `--cwd <path>` was supplied but the path does not exist. */
export class InvokeCwdNotFoundError extends Schema.TaggedError<InvokeCwdNotFoundError>()(
  "InvokeCwdNotFoundError",
  {
    cwd: Schema.String,
    message: Schema.String,
  },
) {}

/** Mutually exclusive invoke flags were combined (e.g. --cwd + --sandbox). */
export class InvokeInvalidArgsError extends Schema.TaggedError<InvokeInvalidArgsError>()(
  "InvokeInvalidArgsError",
  {
    message: Schema.String,
  },
) {}

/** Reading or writing a `~/.pihub/...env` file failed (incl. mode-0600 enforcement). */
export class EnvFileError extends Schema.TaggedError<EnvFileError>()("EnvFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** `pihub env set KEY=value` got malformed input. */
export class EnvParseError extends Schema.TaggedError<EnvParseError>()("EnvParseError", {
  input: Schema.String,
  message: Schema.String,
}) {}

/** AliasStore I/O or schema validation failed. */
export class AliasStoreError extends Schema.TaggedError<AliasStoreError>()("AliasStoreError", {
  message: Schema.String,
}) {}

/** `pihub alias <short>=<canonical>` collided with an existing alias or canonical name. */
export class AliasCollisionError extends Schema.TaggedError<AliasCollisionError>()(
  "AliasCollisionError",
  {
    name: Schema.String,
    message: Schema.String,
  },
) {}

/** `pihub alias remove <short>` referenced a name that doesn't exist. */
export class AliasNotFoundError extends Schema.TaggedError<AliasNotFoundError>()(
  "AliasNotFoundError",
  {
    name: Schema.String,
    message: Schema.String,
  },
) {}

/** LogStore I/O failed (write/read/prune/scan). */
export class LogStoreError extends Schema.TaggedError<LogStoreError>()("LogStoreError", {
  message: Schema.String,
}) {}

/** `pihub logs --invocation-id <id>` referenced an id that doesn't exist on disk. */
export class LogNotFoundError extends Schema.TaggedError<LogNotFoundError>()("LogNotFoundError", {
  invocationId: Schema.String,
  message: Schema.String,
}) {}
