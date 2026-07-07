/**
 * LspManager: routes language-intelligence queries to the right LangProvider
 * by file extension, lazy-starting providers on first use.
 *
 * Also exports `createWorktreeLsp(repoPath, sha)` — a LONG-LIVED variant of
 * src/context/worktree.ts's withWorktree: it creates (or, since Wave 5,
 * REUSES from a per-(repo, sha) pool in the OS tmpdir) a detached worktree
 * and hands back {manager, worktreePath, reused, cleanup}, so a running
 * review server can keep answering LSP queries. Callers own the cleanup()
 * call; cleanup disposes providers but leaves the pooled checkout for the
 * next start — the age-based stale sweep reclaims abandoned ones.
 *
 * Coordinates are 1-based lines/cols throughout (types.ts convention).
 * `file` arguments may be worktree-relative or absolute.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

import { createTsProvider } from "./ts.ts";
import { createRustProvider } from "./rust.ts";
import { createJavaProvider } from "./java.ts";
import type {
  Diag,
  DefResult,
  HoverResult,
  LangProvider,
  LangStatus,
} from "./types.ts";

/** Availability of the provider responsible for one file. */
export interface FileAvailability {
  available: boolean;
  installHint?: string;
}

export interface LspManager {
  /** The provider registered for `file`'s extension, or null. */
  providerFor(file: string): LangProvider | null;
  /**
   * Is there a working provider for this file? Runs the cheap binary probe
   * (cached) but does NOT fully start the provider.
   */
  availability(file: string): Promise<FileAvailability>;
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
  /** Per-language-family status keyed by provider label ("ts", "rust", "java"). */
  status(): Promise<Record<string, LangStatus>>;
  dispose(): Promise<void>;
}

export function createLspManager(worktreeRoot: string): LspManager {
  // Providers are constructed eagerly (cheap — nothing spawns) but START
  // lazily: ready() runs on first query for their extension.
  const providers: Record<string, LangProvider> = {
    ts: createTsProvider(worktreeRoot),
    rust: createRustProvider(worktreeRoot),
    java: createJavaProvider(worktreeRoot),
  };

  const byExtension = new Map<string, LangProvider>();
  for (const provider of Object.values(providers)) {
    for (const ext of provider.languages) byExtension.set(ext, provider);
  }

  function providerFor(file: string): LangProvider | null {
    const ext = extname(file).replace(/^\./, "").toLowerCase();
    return byExtension.get(ext) ?? null;
  }

  /** Start (lazily) and return the provider if it can serve, else null. */
  async function usable(file: string): Promise<LangProvider | null> {
    const provider = providerFor(file);
    if (!provider) return null;
    await provider.ready();
    return provider.state() === "unavailable" ? null : provider;
  }

  return {
    providerFor,

    async availability(file): Promise<FileAvailability> {
      const provider = providerFor(file);
      if (!provider) return { available: false };
      const available =
        provider.state() === "unavailable" ? false : await provider.detect();
      return available
        ? { available: true }
        : { available: false, installHint: provider.installHint };
    },

    async hover(file, line, character): Promise<HoverResult | null> {
      const provider = await usable(file);
      return provider ? provider.hover(file, line, character) : null;
    },

    async definition(file, line, character): Promise<DefResult[]> {
      const provider = await usable(file);
      return provider ? provider.definition(file, line, character) : [];
    },

    async diagnostics(file): Promise<Diag[]> {
      const provider = await usable(file);
      return provider ? provider.diagnostics(file) : [];
    },

    async status(): Promise<Record<string, LangStatus>> {
      const out: Record<string, LangStatus> = {};
      for (const [label, provider] of Object.entries(providers)) {
        const state = provider.state();
        const available =
          state === "unavailable" ? false : await provider.detect();
        out[label] = {
          available,
          // A never-started provider whose binary is missing is reported
          // "unavailable" up front, so the UI can show the install hint.
          state: !available && state === "off" ? "unavailable" : state,
          ...(available ? {} : { installHint: provider.installHint }),
          // Debug/memory telemetry (e.g. ts provider's live project count).
          ...(provider.stats ? provider.stats() : {}),
        };
      }
      return out;
    },

    async dispose(): Promise<void> {
      await Promise.allSettled(
        Object.values(providers).map((p) => p.dispose()),
      );
    },
  };
}

// --- Long-lived worktree + LSP composition ----------------------------------------------

/**
 * Temp-dir prefix of the LEGACY mkdtemp-per-run scheme (pre-Wave-5). No longer
 * created, but servers started before the pool landed still hold these (their
 * registrations protect them), and old leaks linger — the sweep keeps matching
 * them at the original 1h age.
 */
const WORKTREE_PREFIX = "sleek-lsp-worktree-";
/** Temp-dir prefix of the Wave-5 worktree POOL (one reusable dir per repo+sha). */
const POOLED_WORKTREE_PREFIX = "sleek-wt-";
/** A legacy (throwaway) dir must be this old (mtime) before the sweep removes it. */
const STALE_WORKTREE_MS = 60 * 60 * 1000;
/** A pooled worktree is MEANT to outlive its server (reuse), so it gets a day. */
const STALE_POOLED_WORKTREE_MS = 24 * 60 * 60 * 1000;

/** The sweep age threshold for a candidate dir, by naming scheme; null = not ours. */
function staleAfterMs(name: string): number | null {
  if (name.startsWith(WORKTREE_PREFIX)) return STALE_WORKTREE_MS;
  if (name.startsWith(POOLED_WORKTREE_PREFIX)) return STALE_POOLED_WORKTREE_MS;
  return null;
}

/**
 * Pure decision core of the stale-worktree sweep: which candidate temp dirs are safe
 * to delete? Only dirs that (a) carry one of our worktree prefixes, (b) are NOT
 * registered as active worktrees of the repo, and (c) are older than that scheme's
 * threshold — an hour for legacy sleek-lsp-worktree- throwaways, ~a day for pooled
 * sleek-wt- dirs (reused across restarts; see createWorktreeLsp). A concurrently
 * RUNNING server's worktree is registered, so (b) protects it; (c) additionally
 * protects a racing process between reserving the dir and `git worktree add`, and
 * worktrees registered against some OTHER repo (which (b) can't see). Registration
 * is compared by basename — names are unique across schemes, and this sidesteps
 * symlinked tmpdirs (macOS /var/folders vs /private/var/folders) disagreeing with
 * the paths git reports.
 */
export function selectStaleWorktrees(
  candidates: { path: string; mtimeMs: number }[],
  activeWorktreePaths: string[],
  nowMs: number,
): string[] {
  const active = new Set(activeWorktreePaths.map((p) => basename(p)));
  return candidates
    .filter((c) => {
      const threshold = staleAfterMs(basename(c.path));
      return threshold !== null && nowMs - c.mtimeMs > threshold;
    })
    .filter((c) => !active.has(basename(c.path)))
    .map((c) => c.path);
}

/**
 * Best-effort sweep of leaked sibling worktree dirs in `parent` (an unclean shutdown
 * skips cleanup(), leaking the checkout; pooled dirs additionally outlive clean
 * shutdowns by design) before a new one is created. Deletes nothing `git worktree
 * list` still claims (see selectStaleWorktrees); never throws.
 */
async function sweepStaleWorktrees(git: SimpleGit, parent: string): Promise<void> {
  try {
    const names = await readdir(parent);
    const candidates = await Promise.all(
      names
        .filter((n) => staleAfterMs(n) !== null)
        .map(async (n) => {
          const path = join(parent, n);
          return { path, mtimeMs: (await stat(path)).mtimeMs };
        }),
    );
    const activePaths = (await git.raw(["worktree", "list", "--porcelain"]))
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
    for (const path of selectStaleWorktrees(candidates, activePaths, Date.now())) {
      await rm(path, { recursive: true, force: true });
    }
    // Registrations whose dirs are now gone (just removed, or vanished earlier) are
    // prunable; keeps `git worktree list` honest for the next sweep.
    await git.raw(["worktree", "prune"]);
  } catch {
    /* best-effort: a failed sweep must never block creating the new worktree */
  }
}

export interface WorktreeLsp {
  /** Absolute path of the detached checkout the manager answers from. */
  worktreePath: string;
  manager: LspManager;
  /** Wave-5 pool telemetry: true when an existing checkout at `sha` was reused. */
  reused: boolean;
  /**
   * Dispose providers and prune dangling registrations. The checkout itself is
   * NOT removed — it is the pool, reused by the next start at the same (repo, sha)
   * and eventually reclaimed by the stale sweep (~24h unused).
   */
  cleanup(): Promise<void>;
}

/**
 * Stable pool location for the (repo, sha) worktree: sleek-wt-<sha12>-<repo8> in the
 * OS tmpdir. Outside the repo so the checkout is never mistaken for user files, and
 * outside Sleek's own .sleek/ because the worktree belongs to the TARGET repo, not
 * to Sleek. The repo-path hash keeps two clones at the same SHA from sharing one
 * checkout (its .git file and node_modules symlink point at ONE specific clone).
 */
export function pooledWorktreePath(repoPath: string, sha: string): string {
  const repoHash = createHash("sha256").update(resolve(repoPath)).digest("hex");
  return join(
    tmpdir(),
    `${POOLED_WORKTREE_PREFIX}${sha.slice(0, 12)}-${repoHash.slice(0, 8)}`,
  );
}

/**
 * Pure decision core of the worktree pool: given what exists at the pooled path,
 * reuse it, tear it down and recreate, or create fresh. Reuse requires the
 * checkout's HEAD to resolve to exactly the wanted sha — anything else (missing
 * dir, unreadable HEAD from a pruned registration, different sha after eviction
 * races) is rebuilt from scratch.
 */
export function worktreeReuseDecision(
  existing: { exists: boolean; headSha: string | null },
  sha: string,
): "reuse" | "recreate" | "create" {
  if (!existing.exists) return "create";
  return existing.headSha === sha ? "reuse" : "recreate";
}

/**
 * Create — or reuse — the pooled detached worktree of `repoPath` at `sha` (like
 * withWorktree, but long-lived) and an LspManager rooted in it. Wave 5 replaced the
 * mkdtemp-per-run throwaway with a stable per-(repo, sha) checkout: a restart at the
 * same head SHA skips `git worktree add` (the expensive checkout of a large repo)
 * and the node_modules symlink entirely. cleanup() keeps the checkout on disk; the
 * stale sweep reclaims pooled dirs untouched for ~24h.
 *
 * serve-demo wiring (scripts/serve-demo.ts):
 *   const lsp = await createWorktreeLsp(repoPath, reviewScaffold.pr.headSha);
 *   // pass `lsp: lsp.manager` into startServer(...); call lsp.cleanup() on shutdown.
 */
export async function createWorktreeLsp(
  repoPath: string,
  sha: string,
): Promise<WorktreeLsp> {
  const git: SimpleGit = simpleGit(repoPath);
  // Sweep siblings leaked by past unclean shutdowns / long-abandoned pool entries.
  await sweepStaleWorktrees(git, tmpdir());

  const worktreePath = pooledWorktreePath(repoPath, sha);
  let headSha: string | null = null;
  if (existsSync(worktreePath)) {
    try {
      headSha = (await simpleGit(worktreePath).revparse(["HEAD"])).trim();
    } catch {
      headSha = null; // unreadable checkout (e.g. pruned registration) → recreate
    }
  }

  const decision = worktreeReuseDecision(
    { exists: existsSync(worktreePath), headSha },
    sha,
  );
  const reused = decision === "reuse";
  if (decision === "recreate") {
    await rm(worktreePath, { recursive: true, force: true });
    await git.raw(["worktree", "prune"]).catch(() => {});
  }
  if (reused) {
    // Freshen mtime so the age-based sweep sees the pool entry as in-use.
    const now = new Date();
    await utimes(worktreePath, now, now).catch(() => {});
  } else {
    // `--detach`: no branch created or moved; the user's HEAD/index untouched.
    await git.raw(["worktree", "add", "--detach", worktreePath, sha]);
  }

  // Best-effort: worktree checkouts contain no node_modules (untracked), so
  // module/type resolution would fail wholesale. Symlink the source repo's
  // install into the worktree root (skipped when the reused pool entry already
  // has it). Workspace packages behind that symlink resolve to the USER's tree,
  // not this SHA — acceptable staleness for hover/definition; real files in the
  // worktree always win first.
  try {
    const repoModules = resolve(repoPath, "node_modules");
    const worktreeModules = join(worktreePath, "node_modules");
    if (existsSync(repoModules) && !existsSync(worktreeModules)) {
      await symlink(repoModules, worktreeModules, "dir");
    }
  } catch {
    /* degrade: unresolved imports become diagnostics, never crashes */
  }

  const manager = createLspManager(worktreePath);

  return {
    worktreePath,
    manager,
    reused,
    async cleanup(): Promise<void> {
      try {
        await manager.dispose();
      } catch {
        /* best-effort */
      }
      // The checkout stays: it IS the pool. Prune only registrations whose dirs
      // vanished (a swept sibling), keeping `git worktree list` honest.
      try {
        await git.raw(["worktree", "prune"]);
      } catch {
        /* ignore */
      }
    },
  };
}
