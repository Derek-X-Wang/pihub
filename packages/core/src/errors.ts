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
