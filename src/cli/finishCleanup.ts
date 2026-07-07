import { existsSync, rmSync, statSync } from "node:fs";

import { simpleGit } from "simple-git";

import { pooledWorktreePath } from "../lsp/manager.ts";

export interface FinishCleanupPlan {
  cacheFiles: string[];
  worktreePath: string;
  worktreeExists: boolean;
}

export interface FinishCleanupOptions {
  repo: string;
  headSha: string;
  cacheDbPath?: string;
  worktreePath?: string;
}

export function finishCleanupPlan(opts: FinishCleanupOptions): FinishCleanupPlan {
  const cacheDb = opts.cacheDbPath ?? `${opts.repo}/.sleek/cache.db`;
  const cacheFiles = [cacheDb, `${cacheDb}-wal`, `${cacheDb}-shm`].filter((p) =>
    existsSync(p),
  );
  const worktreePath = opts.worktreePath ?? pooledWorktreePath(opts.repo, opts.headSha);
  return {
    cacheFiles,
    worktreePath,
    worktreeExists: existsSync(worktreePath),
  };
}

export function describeFinishCleanup(plan: FinishCleanupPlan): string {
  if (plan.cacheFiles.length === 0 && !plan.worktreeExists) {
    return "Nothing to clean.\n";
  }

  const lines = ["What would be removed:", ""];
  for (const file of plan.cacheFiles) {
    lines.push(`  cache          ${formatBytes(fileSize(file)).padStart(8)}  ${file}`);
  }
  if (plan.worktreeExists) {
    lines.push(`  worktree                 ${plan.worktreePath}`);
  }
  lines.push("", "  .sleek/demo.db is NEVER removed (it holds your threads, reviews and saved replies).");
  return lines.join("\n") + "\n";
}

export async function applyFinishCleanup(plan: FinishCleanupPlan, repo: string): Promise<void> {
  const git = simpleGit(repo);

  if (plan.worktreeExists) {
    try {
      await git.raw(["worktree", "remove", "--force", plan.worktreePath]);
    } catch {
      // It may already be unregistered; filesystem cleanup below is still valid.
    }
    rmSync(plan.worktreePath, { recursive: true, force: true });
  }

  for (const file of plan.cacheFiles) {
    rmSync(file, { force: true });
  }

  try {
    await git.raw(["worktree", "prune"]);
  } catch {
    // Best-effort; stale registrations should not make finish fail after cleanup.
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
