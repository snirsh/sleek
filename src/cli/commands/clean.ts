/**
 * Wave-6 `sleek clean` — dry-run (default) or remove caches and pooled worktrees.
 *
 * NEVER touches .sleek/demo.db (user's threads/reviews live there).
 * By default prints what would be removed and requires --yes to actually delete.
 * Skips worktrees that were modified within the last hour (possibly in use).
 */

import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CleanOptions {
  repo: string;
  yes: boolean;
}

export async function runClean(opts: CleanOptions): Promise<void> {
  const { repo, yes } = opts;

  const cacheDb = `${repo}/.sleek/cache.db`;
  const demoDb = `${repo}/.sleek/demo.db`;

  // Collect cache.db info
  const cacheExists = existsSync(cacheDb);
  let cacheSize = 0;
  if (cacheExists) {
    try {
      cacheSize = statSync(cacheDb).size;
    } catch { /* ignore */ }
  }

  // Collect sleek-wt-* worktree dirs in tmpdir
  const tmp = tmpdir();
  const wtDirs: { path: string; age: string; fresh: boolean; size: number }[] = [];

  try {
    const entries = readdirSync(tmp);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;

    for (const entry of entries) {
      if (!entry.startsWith("sleek-wt-")) continue;
      const full = join(tmp, entry);
      try {
        const st = statSync(full);
        if (!st.isDirectory()) continue;
        const ageMsDiff = now - st.mtimeMs;
        const fresh = ageMsDiff < oneHour;
        wtDirs.push({
          path: full,
          age: humanAge(ageMsDiff),
          fresh,
          size: estimateDirSize(full),
        });
      } catch { /* ignore */ }
    }
  } catch { /* ignore — tmpdir not readable */ }

  const toDelete = wtDirs.filter((w) => !w.fresh);
  const toSkip = wtDirs.filter((w) => w.fresh);

  // Print plan
  if (!cacheExists && toDelete.length === 0 && toSkip.length === 0) {
    process.stdout.write("Nothing to clean.\n");
    return;
  }

  process.stdout.write("What would be removed:\n\n");

  if (cacheExists) {
    process.stdout.write(
      `  cache.db       ${formatBytes(cacheSize).padStart(8)}  ${cacheDb}\n`,
    );
  }

  for (const w of toDelete) {
    process.stdout.write(
      `  worktree       ${formatBytes(w.size).padStart(8)}  ${w.path}  (${w.age} old)\n`,
    );
  }

  if (toSkip.length > 0) {
    process.stdout.write("\nSkipping (modified < 1h ago, possibly in use):\n");
    for (const w of toSkip) {
      process.stdout.write(`  ${w.path}  (${w.age} old)\n`);
    }
  }

  process.stdout.write(
    "\n  .sleek/demo.db is NEVER removed (it holds your threads, reviews and saved replies).\n",
  );

  if (!yes) {
    process.stdout.write("\nDry run — pass --yes to delete.\n");
    return;
  }

  // Refuse to touch demo.db even with --yes (belt and suspenders)
  if (existsSync(demoDb)) {
    process.stdout.write(
      "\nRefusing to touch demo.db: it holds your threads, reviews and saved replies.\n",
    );
  }

  // Delete
  if (cacheExists) {
    try {
      rmSync(cacheDb);
      process.stdout.write(`Deleted: ${cacheDb}\n`);
    } catch (err) {
      process.stderr.write(`Failed to delete ${cacheDb}: ${String(err)}\n`);
    }
  }

  for (const w of toDelete) {
    try {
      rmSync(w.path, { recursive: true, force: true });
      process.stdout.write(`Deleted: ${w.path}\n`);
    } catch (err) {
      process.stderr.write(`Failed to delete ${w.path}: ${String(err)}\n`);
    }
  }
}

function humanAge(diffMs: number): string {
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** Best-effort directory size estimate (doesn't recurse deeply — just top-level). */
function estimateDirSize(dir: string): number {
  try {
    let total = 0;
    for (const entry of readdirSync(dir)) {
      try {
        const st = statSync(join(dir, entry));
        total += st.size;
      } catch { /* ignore */ }
    }
    return total;
  } catch {
    return 0;
  }
}
