/**
 * Wave-6 `sleek regions <pr>` — dump changed regions (anchors) for a PR.
 * Reuses what scripts/dump-regions.ts does via the real gh runner.
 */

import { openCache } from "../../cache/cache.ts";
import { createCachingGhRunner } from "../../cache/gh.ts";
import { parseChangedRegions } from "../../context/diff.ts";
import { IngestError, defaultGhRunner, ingestPr } from "../../ingest/ingest.ts";
import { friendlyIngestError, formatFriendlyError } from "../errors.ts";
import { mkdirSync } from "node:fs";

export interface RegionsOptions {
  pr: number;
  repo: string;
  json: boolean;
}

export async function runRegions(opts: RegionsOptions): Promise<void> {
  const { pr, repo, json: jsonMode } = opts;

  mkdirSync(`${repo}/.sleek`, { recursive: true });
  const cache = openCache(`${repo}/.sleek/cache.db`);

  try {
    // Use the caching gh runner so repeated calls are fast.
    const gh = createCachingGhRunner({
      cache,
      repoUrl: repo,
      prNumber: pr,
      refresh: false,
      inner: defaultGhRunner,
    });

    const changeSet = await ingestPr(pr, { cwd: repo, gh });
    const regions = parseChangedRegions(changeSet.unifiedDiff);

    if (jsonMode) {
      process.stdout.write(
        JSON.stringify(
          {
            pr: {
              number: changeSet.pr.number,
              title: changeSet.pr.title,
              headSha: changeSet.pr.headSha,
            },
            regions: regions.map((r) => ({
              file: r.file,
              side: r.side,
              startLine: r.startLine,
              endLine: r.endLine,
            })),
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      process.stdout.write(
        `PR #${changeSet.pr.number}: ${changeSet.pr.title}\n` +
        `Head: ${changeSet.pr.headSha}\n\n`,
      );
      for (const r of regions) {
        process.stdout.write(
          `  ${r.side.padEnd(5)}  ${r.file}:${r.startLine}-${r.endLine}\n`,
        );
      }
      process.stdout.write(`\n${regions.length} region(s)\n`);
    }
  } catch (err) {
    if (err instanceof IngestError) {
      const friendly = friendlyIngestError(err.kind, { prNumber: pr, repoPath: repo });
      process.stderr.write(formatFriendlyError(friendly) + "\n");
      process.exit(friendly.exitCode);
    }
    process.stderr.write(`Unexpected error: ${String(err)}\n`);
    process.exit(2);
  } finally {
    cache.close();
  }
}
