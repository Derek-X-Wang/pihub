/** Information about a single shape-β sub-agent declared in `agents/<sub>.md`. */
export interface BetaAgentInfo {
  readonly subName: string;
  readonly description: string;
  /** Path to the markdown file relative to the source repo root. */
  readonly mdPath: string;
}

/** Information extracted from a shape-α (Pi package) repo's `package.json`. */
export interface AlphaAgentInfo {
  /** The package's published name (`@scope/pkg` or `pkg`). */
  readonly packageName: string;
  /** Effective human description: `pi.description` if set, else `description`. */
  readonly description: string;
  /** Raw semver range from `dependencies["@mariozechner/pi-coding-agent"]`, if any. */
  readonly piRange: string | undefined;
}

/**
 * Outcome of inspecting a repo for shape α (Pi package via `package.json.pi`)
 * or shape β (markdown agents under `agents/*.md`).
 */
export type DetectionResult =
  | { readonly kind: "alpha"; readonly info: AlphaAgentInfo }
  | { readonly kind: "beta"; readonly agents: ReadonlyArray<BetaAgentInfo> };

/**
 * Information SourceFetcher returns after materialising a source into the
 * agent repo dir. `commitSha` is a real SHA for git sources, a synthesised
 * file-tree hash for local copies, the resolved version for npm, and a
 * sentinel `link:<absolutePath>` for --link installs (where the tree
 * mutates so a content hash is meaningless).
 */
export interface SourceInfo {
  readonly source: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly depsLockSha: string;
  /** True iff the fetcher used a symlink (--link) instead of materialising bytes. */
  readonly link: boolean;
}

/** Install-time options forwarded from the CLI to SourceFetcher and Installer. */
export interface InstallOptions {
  /** CI mode: fail with FrozenDriftError on any state drift. */
  readonly frozen?: boolean;
  /** Live-dev mode: symlink instead of cp -r (local sources only). */
  readonly link?: boolean;
}
