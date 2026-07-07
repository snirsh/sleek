/**
 * Provider-agnostic language-intelligence interface for the Wave LSP backend.
 *
 * COORDINATE CONVENTION: every line AND column in these types is 1-based —
 * the first character of a file is line 1, column 1. This matches the Anchor
 * convention (GitHub review coordinates) used across Sleek. The LSP wire
 * protocol (and the TypeScript compiler API) are 0-based; providers convert
 * at their own boundary and never leak 0-based positions out of this module.
 *
 * File paths passed INTO providers are absolute paths inside the worktree;
 * file paths coming OUT (DefResult.file) are worktree-relative when the
 * target lives inside the worktree, absolute otherwise (e.g. lib.d.ts).
 */

/** A 1-based, inclusive-start position range within a single file. */
export interface LspRange {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

/** Result of a hover query: markdown contents, optionally the symbol's range. */
export interface HoverResult {
  /** Markdown; signatures are fenced (```ts / ```rust / …). */
  contents: string;
  range?: LspRange;
}

/** One go-to-definition target. */
export interface DefResult {
  /** Worktree-relative path when inside the worktree, absolute otherwise. */
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  /** The target line's text, trimmed — a one-line preview. */
  preview?: string;
}

export type DiagSeverity = "error" | "warning" | "info" | "hint";

/** One diagnostic for a file. */
export interface Diag {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
  severity: DiagSeverity;
  message: string;
  /** Producer tag, e.g. "ts", "rust-analyzer", "jdtls". */
  source?: string;
}

/**
 * Provider lifecycle state.
 * - "off": constructed, not yet started (lazy).
 * - "starting": binary detection / spawn / handshake in flight.
 * - "ready": answering queries.
 * - "warming": alive but slow (e.g. rust-analyzer still indexing — a request
 *   timed out; later requests may succeed).
 * - "unavailable": cannot serve (binary missing, spawn failed).
 */
export type ProviderState =
  | "off"
  | "starting"
  | "ready"
  | "warming"
  | "unavailable";

/**
 * One language provider. All query methods are total: they resolve to
 * null/[] on any internal failure rather than rejecting.
 */
export interface LangProvider {
  /** File extensions (no dot) this provider handles, e.g. ["ts", "tsx"]. */
  languages: string[];
  /**
   * Start (or finish starting) the provider. Resolves even when the provider
   * ends up "unavailable" — check state() afterwards. Idempotent.
   */
  ready(): Promise<void>;
  /** Current lifecycle state (see ProviderState). */
  state(): ProviderState;
  /** Cheap availability probe (e.g. `--version`); does NOT fully start. Cached. */
  detect(): Promise<boolean>;
  /** How to install the backing tool, when state() === "unavailable". */
  installHint?: string;
  /**
   * Optional memory/debug telemetry, merged into this provider's LangStatus.
   * The ts provider reports its live LanguageService cache: `projects.count`
   * currently alive vs the LRU cap `projects.max` (SLEEK_LSP_MAX_PROJECTS).
   */
  stats?(): { projects: { count: number; max: number } };
  hover(
    file: string,
    line: number,
    character: number,
  ): Promise<HoverResult | null>;
  definition(
    file: string,
    line: number,
    character: number,
  ): Promise<DefResult[]>;
  diagnostics(file: string): Promise<Diag[]>;
  dispose(): Promise<void>;
}

/** Per-language entry of LspManager.status(). */
export interface LangStatus {
  available: boolean;
  state: ProviderState;
  installHint?: string;
  /** Present when the provider exposes stats(): live project cache size vs cap. */
  projects?: { count: number; max: number };
}
