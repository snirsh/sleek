/**
 * Worktree lifecycle. Per ADR-0001, Context Building must NEVER disturb the Reviewer's
 * working tree or branch: we analyze the PR head SHA through a *detached* git worktree
 * checked out in a throwaway temp directory. `git worktree add --detach <path> <sha>`
 * gives us a full checkout at that SHA without touching HEAD, the index, or any branch
 * in the user's clone.
 *
 * The worktree is always removed afterwards — including when `fn` throws — via a
 * try/finally, so we never leak temp checkouts or worktree registrations.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

/** Options for withWorktree. */
export interface WithWorktreeOpts {
  /**
   * Additional refs to fetch from origin when the SHA is not locally available.
   * Callers pass ["pull/<pr>/head"] so the PR head is fetched on the first miss.
   * Fetches are attempted in order: first `git fetch origin <sha>`, then each ref.
   */
  fetchRefs?: string[];
}

/**
 * Pattern matching git errors that indicate the SHA is not locally available.
 * Covers: "invalid reference", "not a valid object name", "bad object".
 */
const MISSING_OBJECT_RE = /invalid reference|not a valid object name|bad object/i;

/**
 * Try `git worktree add --detach <path> <sha>`. On a missing-object error, fetch from
 * origin and retry. Throws if all fetch attempts are exhausted without success.
 */
async function worktreeAddWithFallback(
  git: SimpleGit,
  worktreePath: string,
  sha: string,
  fetchRefs: string[],
): Promise<void> {
  // First attempt without any fetch.
  try {
    await git.raw(["worktree", "add", "--detach", worktreePath, sha]);
    return;
  } catch (firstErr) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    if (!MISSING_OBJECT_RE.test(msg)) throw firstErr;
  }

  // Build the ordered list of refs to try: the sha itself first, then caller refs.
  const refsToTry = [sha, ...fetchRefs];
  const tried: string[] = [];

  for (const ref of refsToTry) {
    tried.push(ref);
    try {
      await git.raw(["fetch", "origin", ref]);
    } catch {
      // Fetch failed for this ref — continue to the next.
      continue;
    }
    // Fetch succeeded — retry worktree add.
    try {
      await git.raw(["worktree", "add", "--detach", worktreePath, sha]);
      return;
    } catch (retryErr) {
      const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      if (!MISSING_OBJECT_RE.test(msg)) throw retryErr;
      // Still missing after this fetch — continue to the next ref.
    }
  }

  throw new Error(
    "withWorktree: SHA " + sha + " could not be resolved after fetching refs: " + tried.join(", "),
  );
}

/**
 * Create a detached worktree of `repoPath` at `sha` in a fresh temp directory, run
 * `fn` against that worktree's path, then tear the worktree down. Cleanup runs even if
 * `fn` rejects; the original error is re-thrown after cleanup.
 *
 * The user's checkout is never modified: no branch is created or switched, and the
 * temp worktree is force-removed and pruned on exit.
 *
 * When `opts.fetchRefs` is provided and the initial `worktree add` fails with a
 * missing-object error, the function automatically fetches from origin before retrying.
 */
export async function withWorktree<T>(
  repoPath: string,
  sha: string,
  fn: (worktreePath: string) => Promise<T>,
  opts?: WithWorktreeOpts,
): Promise<T> {
  const git: SimpleGit = simpleGit(repoPath);

  // A temp dir OUTSIDE the repo so the worktree checkout can never be mistaken for
  // part of the user's tree.
  const worktreePath = await mkdtemp(join(tmpdir(), "sleek-worktree-"));

  // `--detach` => no branch is created or moved; HEAD in the main clone is untouched.
  // With fetch fallback: on missing-object errors, fetch refs and retry.
  // If worktreeAddWithFallback throws, clean up the temp dir before re-throwing.
  try {
    await worktreeAddWithFallback(git, worktreePath, sha, opts?.fetchRefs ?? []);
  } catch (addErr) {
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw addErr;
  }

  try {
    return await fn(worktreePath);
  } finally {
    // Force-remove the worktree registration + checkout, then prune stale admin files.
    // Best-effort: swallow cleanup errors so they never mask an error from `fn`.
    try {
      await git.raw(["worktree", "remove", "--force", worktreePath]);
    } catch {
      // Fall through to filesystem cleanup + prune below.
    }
    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      await git.raw(["worktree", "prune"]);
    } catch {
      /* ignore */
    }
  }
}
