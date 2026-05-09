/** Information about a single shape-β sub-agent declared in `agents/<sub>.md`. */
export interface BetaAgentInfo {
  readonly subName: string;
  readonly description: string;
  /** Path to the markdown file relative to the source repo root. */
  readonly mdPath: string;
}

/**
 * Outcome of inspecting a repo for shape α (Pi package via `package.json.pi`)
 * or shape β (markdown agents under `agents/*.md`). Slice #3 ships β only;
 * the α branch is a stub completed in slice #9.
 */
export type DetectionResult =
  | { readonly kind: "alpha" }
  | { readonly kind: "beta"; readonly agents: ReadonlyArray<BetaAgentInfo> };

/**
 * Information SourceFetcher returns after materialising a source into the
 * agent repo dir. `commitSha` is a real SHA for git sources and a synthesised
 * file-tree hash for local paths.
 */
export interface SourceInfo {
  readonly source: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly depsLockSha: string;
}
