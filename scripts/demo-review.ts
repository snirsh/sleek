/**
 * DEMO harness (not part of the product build). Runs the real Sleek pipeline against a
 * real GitHub PR to produce a Review Scaffold you can look at, WITHOUT an Anthropic API
 * key: the Scaffolder LLM is injected (LlmRunner) with a review authored by Opus reading
 * the real diff. Everything else is the real code path:
 *   real gh ingest (M1) → real diff-region parsing (M2 diff.ts) → real M3 assembly +
 *   tiling + zod validation → real M4 SQLite store → HTML render.
 *
 * The reusable pipeline core (authored-review loading + buildDemoScaffold) lives in
 * demo-data.ts, shared with serve-demo.ts — as is the Wave-5 fast path: gh view/diff,
 * the scaffold (store), and the rendered HTML are cached (SLEEK_REFRESH=1 re-fetches
 * gh), and the per-stage timing table prints at the end.
 *
 * Run: npx tsx scripts/demo-review.ts <repoPath> <prNumber> [outHtmlPath]
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { openCache } from "../src/cache/cache.ts";
import { createCachingGhRunner } from "../src/cache/gh.ts";
import { defaultGhRunner } from "../src/ingest/ingest.ts";
import { createTimeline } from "../src/perf/timing.ts";
import { openStore } from "../src/store/index.ts";
import {
  buildDemoScaffold,
  githubRepoUrl,
  renderDemoHtmlCached,
  GITHUB_REPO_URL,
} from "../src/review/pipeline.ts";

const [repoPath, prArg, outArg] = process.argv.slice(2);
if (!repoPath || !prArg) {
  console.error("usage: tsx scripts/demo-review.ts <repoPath> <prNumber> [outHtmlPath]");
  process.exit(1);
}
const prNumber = Number(prArg);

async function main() {
  const timeline = createTimeline();

  // Same persistent .sleek/ state as serve-demo, so both share one fast path.
  mkdirSync(".sleek", { recursive: true });
  const cache = openCache(".sleek/cache.db");
  const store = openStore(".sleek/demo.db");

  const repoUrl = (await githubRepoUrl(repoPath)) ?? GITHUB_REPO_URL;
  const gh = createCachingGhRunner({
    cache,
    repoUrl,
    prNumber,
    refresh: process.env.SLEEK_REFRESH === "1",
    timeline,
    inner: defaultGhRunner,
  });

  const result = await buildDemoScaffold(repoPath, prNumber, { gh, store, timeline });
  const { reviewScaffold } = result;

  // Real M4 store round-trip (buildDemoScaffold saved on build / replayed on hit).
  const roundTripped = store.getScaffold(reviewScaffold.pr.number, reviewScaffold.pr.headSha);
  console.log(`  ✓ stored + read back: ${roundTripped ? "ok" : "FAILED"}`);

  const html = renderDemoHtmlCached(cache, result, timeline);
  const out = outArg ?? `${process.cwd()}/scripts/review.html`;
  writeFileSync(out, html);

  store.close();
  cache.close();

  console.log(`\n${timeline.table()}`);
  console.log(`\n✓ wrote ${out}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
