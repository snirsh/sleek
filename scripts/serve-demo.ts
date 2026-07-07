/**
 * DEMO server (not part of the product build). Runs the demo pipeline
 * (demo-data.ts — real ingest + real scaffolding with an authored review
 * injected as the Scaffolder LLM), renders the review HTML, and serves it via
 * the local review server (src/server/serve.ts):
 *
 *   GET  /              the review page
 *   GET  /api/health    { ok, model, escalation, threads, context, lsp }
 *   POST /api/ask       streamed Assistant answer (Ollama)
 *   POST /api/escalate  streamed Scaffolder answer (Anthropic or configured CLI agent)
 *   POST /api/context   expandable diff context from the PR-head worktree
 *
 * Run: npx tsx scripts/serve-demo.ts <repoPath> <prNumber> [port]
 *
 * Wave 5 fast path: every stage is timed (table printed at startup) and the
 * expensive ones are cached — gh view (60s TTL; SLEEK_REFRESH=1 re-fetches),
 * gh diff (immutable per head SHA), the scaffold (store, by (pr, headSha)),
 * rendered HTML (content-addressed, incl. renderer version), and the LSP
 * worktree (pooled per (repo, sha)). A warm restart does no gh/git/render work.
 *
 * Very large monorepos: NODE_OPTIONS=--max-old-space-size=8192 adds heap headroom
 * (rarely needed — LSP projects are LRU-capped, see SLEEK_LSP_MAX_PROJECTS).
 */

import { mkdirSync } from "node:fs";

import { openCache } from "../src/cache/cache.ts";
import { createCachingGhRunner } from "../src/cache/gh.ts";
import { parseRepoIdentity } from "../src/export/github.ts";
import { defaultGhRunner, ingestPr } from "../src/ingest/ingest.ts";
import { createWorktreeLsp } from "../src/lsp/manager.ts";
import { createTimeline } from "../src/perf/timing.ts";
import { createFileContextReader, startServer } from "../src/server/serve.ts";
import { createGitBlamer } from "../src/server/blame.ts";
import { createSourceOpener } from "../src/server/opensource.ts";
import { openStore } from "../src/store/index.ts";
import type { ReviewScaffold } from "../src/domain/scaffold.ts";
import { renderReviewHtml } from "../src/render/html.ts";
import { parseUnifiedDiff } from "../src/render/diffmodel.ts";
import {
  buildDemoScaffold,
  buildEmptyScaffold,
  buildScaffoldingClosure,
  githubRepoUrl,
  renderDemoHtmlCached,
  GITHUB_REPO_URL,
} from "./demo-data.ts";

const [repoPath, prArg, portArg] = process.argv.slice(2);
if (!repoPath || !prArg) {
  console.error("usage: tsx scripts/serve-demo.ts <repoPath> <prNumber> [port]");
  process.exit(1);
}
const prNumber = Number(prArg);

async function main() {
  const timeline = createTimeline();

  // Persistent state (.sleek/ is gitignored): threads/comments/reviews + scaffolds
  // in the store; the Wave-5 pipeline cache in its OWN db (purgeable wholesale).
  mkdirSync(".sleek", { recursive: true });
  const cache = openCache(".sleek/cache.db");
  const store = openStore(".sleek/demo.db");

  const repoUrl = (await githubRepoUrl(repoPath)) ?? GITHUB_REPO_URL;
  const repoIdentity = parseRepoIdentity(repoUrl);
  const gh = createCachingGhRunner({
    cache,
    repoUrl,
    prNumber,
    refresh: process.env.SLEEK_REFRESH === "1",
    timeline,
    inner: defaultGhRunner,
  });

  // Explore-first: ingest → check store → hit: full review; miss: empty page
  const changeSet = await ingestPr(prNumber, { cwd: repoPath, gh });
  const storedScaffold = store.getScaffold(prNumber, changeSet.pr.headSha);

  let reviewScaffold: ReviewScaffold;
  let html: string;

  if (storedScaffold) {
    // Store hit: build via buildDemoScaffold (will hit store fast path internally).
    const result = await buildDemoScaffold(repoPath, prNumber, { gh, store, timeline });
    reviewScaffold = result.reviewScaffold;
    html = renderDemoHtmlCached(cache, result, timeline, { lazyLargeFiles: true });
  } else {
    // Explore-first: serve empty scaffold page; scaffold on demand via POST /api/scaffold.
    // lazyLargeFiles=true: large unanchored files omit rows from initial HTML and
    // are fetched on demand from GET /api/filerows, keeping the page small.
    reviewScaffold = buildEmptyScaffold(changeSet);
    const prUrl = await githubRepoUrl(repoPath).then((url) => url ? `${url}/pull/${prNumber}` : `${GITHUB_REPO_URL}/pull/${prNumber}`);
    const renderStart = performance.now();
    html = renderReviewHtml(reviewScaffold, changeSet.unifiedDiff, {}, prUrl, { lazyLargeFiles: true });
    timeline.add("render", performance.now() - renderStart, "lazy (explore-first)");
  }

  // Long-lived worktree at the PR head SHA powers /api/lsp/* (hover/defs/diagnostics).
  // Pooled per (repo, sha): a warm restart reuses the existing checkout.
  const worktreeStart = performance.now();
  const lsp = await createWorktreeLsp(repoPath, reviewScaffold.pr.headSha);
  timeline.add(
    "worktree create",
    performance.now() - worktreeStart,
    lsp.reused ? "reused (pool)" : "created",
  );

  // Parse the diff files once for GET /api/filerows (lazy large-file hydration).
  const diffFiles = parseUnifiedDiff(changeSet.unifiedDiff);

  const listenStart = performance.now();
  const { port, close } = await startServer({
    html,
    scaffold: reviewScaffold,
    prTitle: reviewScaffold.pr.title,
    port: portArg ? Number(portArg) : undefined,
    lsp: lsp.manager,
    lspWorktree: lsp.worktreePath,
    store,
    // Lazy large-file row hydration on demand.
    diffFiles,
    // Expandable context (/api/context) reads head-SHA files from the same worktree.
    contextReader: createFileContextReader(lsp.worktreePath),
    actions: {
      blame: createGitBlamer(repoPath, {
        baseSha: reviewScaffold.pr.baseSha,
        headSha: reviewScaffold.pr.headSha,
      }),
      openSource: createSourceOpener(lsp.worktreePath),
    },
    // Wave 4A review export: identity from the origin remote, RAW gh runner
    // (never the caching wrapper — a review POST must not touch the cache).
    github: repoIdentity
      ? { ...repoIdentity, gh: defaultGhRunner, repoPath }
      : undefined,
    // Wave 7: scaffold capability for replay or anthropic
    scaffolding: buildScaffoldingClosure(repoPath, prNumber, { cache, store, timeline, gh }),
  });
  timeline.add("server listen", performance.now() - listenStart);

  const shutdown = async () => {
    await close().catch(() => {});
    await lsp.cleanup().catch(() => {});
    store.close();
    cache.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  console.log(`\n${timeline.table()}`);
  console.log(`\nSleek review of PR #${prNumber} → http://localhost:${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
