import { IngestError, defaultGhRunner, ingestPr } from "../../ingest/ingest.ts";
import { friendlyIngestError, formatFriendlyError } from "../errors.ts";
import {
  applyFinishCleanup,
  describeFinishCleanup,
  finishCleanupPlan,
} from "../finishCleanup.ts";

export interface FinishOptions {
  pr: number;
  repo: string;
  yes: boolean;
}

export async function runFinish(opts: FinishOptions): Promise<void> {
  const { pr, repo, yes } = opts;

  try {
    const changeSet = await ingestPr(pr, { cwd: repo, gh: defaultGhRunner });
    const plan = finishCleanupPlan({
      repo,
      headSha: changeSet.pr.headSha,
    });

    process.stdout.write(describeFinishCleanup(plan));
    if (!yes) {
      process.stdout.write("\nDry run — pass --yes to delete.\n");
      return;
    }

    await applyFinishCleanup(plan, repo);
    process.stdout.write("\nFinished review cleanup.\n");
  } catch (err) {
    if (err instanceof IngestError) {
      const friendly = friendlyIngestError(err.kind, { prNumber: pr, repoPath: repo });
      process.stderr.write(formatFriendlyError(friendly) + "\n");
      process.exit(friendly.exitCode);
      return;
    }
    throw err;
  }
}
