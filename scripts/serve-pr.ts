/**
 * Real PR server. Ingests a GitHub PR, builds raw context, runs the configured
 * Scaffolder provider, renders the Review Scaffold, and serves the interactive UI.
 *
 * Run:
 *   npx tsx scripts/serve-pr.ts <repoPath> <prNumber> [port]
 *
 * Configure the Scaffolder with SLEEK_SCAFFOLDER_PROVIDER:
 *   claude (default) or codex. anthropic/custom are env-only escape hatches.
 */

import { mkdirSync } from "node:fs";

import { openCache } from "../src/cache/cache.ts";
import { buildContextCached } from "../src/cache/context.ts";
import type { ContextInput, RegionContext } from "../src/context/index.ts";
import { parseChangedRegions } from "../src/context/diff.ts";
import type { ChangeSet, ReviewScaffold } from "../src/domain/scaffold.ts";
import { parseRepoIdentity } from "../src/export/github.ts";
import { defaultGhRunner, ingestPr } from "../src/ingest/ingest.ts";
import { createWorktreeLsp } from "../src/lsp/manager.ts";
import { renderReviewHtml } from "../src/render/html.ts";
import { scaffold } from "../src/scaffolder/scaffolder.ts";
import { startServer } from "../src/server/serve.ts";
import { createGitBlamer } from "../src/server/blame.ts";
import { createSourceOpener } from "../src/server/opensource.ts";
import { openStore } from "../src/store/index.ts";
import {
  buildEmptyScaffold,
  buildScaffoldingClosure,
  githubRepoUrl,
} from "../src/review/pipeline.ts";

const [repoPath, prArg, portArg] = process.argv.slice(2);
if (!repoPath || !prArg) {
  console.error("usage: tsx scripts/serve-pr.ts <repoPath> <prNumber> [port]");
  process.exit(1);
}
const prNumber = Number(prArg);

async function main() {
  // Wave-5 pipeline cache: built ContextInput is deterministic per (headSha, regions).
  mkdirSync(".sleek", { recursive: true });
  const cache = openCache(".sleek/cache.db");
  const store = openStore(".sleek/demo.db");

  console.log(`\n▶ Ingesting PR #${prNumber} from ${repoPath} ...`);
  const changeSet = await ingestPr(prNumber, { cwd: repoPath });
  console.log(`  ${changeSet.pr.title}`);
  console.log(`  files: ${changeSet.files.join(", ")}`);

  const storedScaffold = store.getScaffold(prNumber, changeSet.pr.headSha);

  let reviewScaffold: ReviewScaffold;
  let html: string;

  if (storedScaffold) {
    reviewScaffold = storedScaffold;
    const prUrl = await githubPrUrl(repoPath, prNumber).catch(() => undefined);
    html = renderReviewHtml(reviewScaffold, changeSet.unifiedDiff, {}, prUrl, { lazyLargeFiles: true });
    console.log(`▶ Scaffold loaded from store (${changeSet.pr.headSha.slice(0, 12)}): ${reviewScaffold.layers.length} layers`);
  } else {
    // Explore-first: empty scaffold page
    reviewScaffold = buildEmptyScaffold(changeSet);
    const prUrl = await githubPrUrl(repoPath, prNumber).catch(() => undefined);
    html = renderReviewHtml(reviewScaffold, changeSet.unifiedDiff, {}, prUrl, { lazyLargeFiles: true });
    console.log(`▶ Explore-first: empty scaffold; use Process PR in the UI to scaffold.`);
  }

  const lsp = await createWorktreeLsp(repoPath, reviewScaffold.pr.headSha);
  const repoUrl = await githubRepoUrl(repoPath);
  const repoIdentity = repoUrl ? parseRepoIdentity(repoUrl) : null;
  const { port, close } = await startServer({
    html,
    scaffold: reviewScaffold,
    prTitle: reviewScaffold.pr.title,
    port: portArg ? Number(portArg) : undefined,
    lsp: lsp.manager,
    lspWorktree: lsp.worktreePath,
    store,
    actions: {
      blame: createGitBlamer(repoPath, {
        baseSha: reviewScaffold.pr.baseSha,
        headSha: reviewScaffold.pr.headSha,
      }),
      openSource: createSourceOpener(lsp.worktreePath),
    },
    // Wave 4A review export target (active once a store is wired in; the
    // export route itself lives behind the thread routes' store gate).
    github: repoIdentity
      ? { ...repoIdentity, gh: defaultGhRunner, repoPath }
      : undefined,
    // Wave 7: scaffold capability for replay or anthropic
    scaffolding: buildScaffoldingClosure(repoPath, prNumber, { cache, store, gh: undefined }),
  });

  const shutdown = async () => {
    await close().catch(() => {});
    await lsp.cleanup().catch(() => {});
    cache.close();
    store.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`\nSleek review of PR #${prNumber} -> http://localhost:${port}`);
}

async function githubPrUrl(repoPath: string, pr: number): Promise<string | undefined> {
  const repoUrl = await githubRepoUrl(repoPath);
  return repoUrl ? `${repoUrl}/pull/${pr}` : undefined;
}

function buildLiteContext(changeSet: ChangeSet): ContextInput {
  const regions = parseChangedRegions(changeSet.unifiedDiff).map<RegionContext>((region) => ({
    anchor: {
      file: region.file,
      side: region.side,
      startLine: region.startLine,
      endLine: region.endLine,
    },
    neighbors: [],
    history: [],
  }));
  return { headSha: changeSet.pr.headSha, regions };
}

function diffForScaffolder(changeSet: ChangeSet): string {
  const maxChars = Number(process.env.SLEEK_SCAFFOLDER_DIFF_MAX_CHARS ?? "180000");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return changeSet.unifiedDiff;
  if (changeSet.unifiedDiff.length <= maxChars) return changeSet.unifiedDiff;
  const originalBytes = changeSet.unifiedDiff.length;
  // Count how many file sections fall past the cut: lines starting with "diff --git"
  // that appear after the maxChars offset.
  const truncated = changeSet.unifiedDiff.slice(maxChars);
  const filesDropped = (truncated.match(/^diff --git /gm) ?? []).length;
  console.warn(
    `\n[sleek] WARNING: Scaffolder diff truncated!\n` +
    `  Original size : ${(originalBytes / 1024).toFixed(1)} KB (${originalBytes} chars)\n` +
    `  Cap           : ${(maxChars / 1024).toFixed(1)} KB (SLEEK_SCAFFOLDER_DIFF_MAX_CHARS=${maxChars})\n` +
    `  Files dropped : ~${filesDropped} file section(s) fell past the cut\n` +
    `  The rendered UI still shows the full diff; only the Scaffolder prompt is truncated.\n`,
  );
  return [
    changeSet.unifiedDiff.slice(0, maxChars),
    "",
    `[diff truncated for Scaffolder prompt at ${maxChars} chars; ` +
      "rendered UI still contains the full diff]",
  ].join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
