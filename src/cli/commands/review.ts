/**
 * Wave-6 `sleek review <pr>` command.
 *
 * Wraps the serve-demo pipeline (real ingest + authored-review replay /
 * store-cached scaffold) with:
 *   - Staged progress lines to stderr as each pipeline stage completes
 *   - --open: opens the browser on macOS after listen
 *   - --json: emits one final JSON object on stdout
 *   - --refresh: sets SLEEK_REFRESH=1 equivalent
 *   - --process: runs the scaffold pipeline eagerly at startup (default: explore-first)
 *   - Friendly error messages for all known failure modes
 *   - Ollama probe after listen (warn if down, never fail)
 */

import { mkdirSync } from "node:fs";
import { execFile } from "node:child_process";

import { openCache } from "../../cache/cache.ts";
import { createCachingGhRunner } from "../../cache/gh.ts";
import { parseRepoIdentity } from "../../export/github.ts";
import { IngestError, defaultGhRunner, ingestPr } from "../../ingest/ingest.ts";
import { createWorktreeLsp } from "../../lsp/manager.ts";
import { createFileContextReader, startServer } from "../../server/serve.ts";
import { openStore } from "../../store/index.ts";
import type { ReviewScaffold } from "../../domain/scaffold.ts";
import { renderReviewHtml } from "../../render/html.ts";
import { printProgress, createProgressTimeline } from "../progress.ts";
import { friendlyIngestError, friendlyMissingReviewError, formatFriendlyError } from "../errors.ts";
import { applyFinishCleanup, finishCleanupPlan } from "../finishCleanup.ts";
import { registerServer, unregisterServer } from "../registry.ts";
// Scripts are outside tsconfig include, but tsx resolves them at runtime.
// We use dynamic import to avoid "type module" complications with tsconfig.
import type { DemoScaffoldOptions, DemoScaffoldResult } from "../../../scripts/demo-data.ts";

// Dynamically import from scripts/ at runtime (tsx resolves it; tsconfig excludes scripts/).
async function importDemoData() {
  const mod = await import("../../../scripts/demo-data.ts") as {
    buildDemoScaffold: (repo: string, pr: number, opts: DemoScaffoldOptions) => Promise<DemoScaffoldResult>;
    githubRepoUrl: (path: string) => Promise<string | undefined>;
    renderDemoHtmlCached: (cache: ReturnType<typeof openCache>, result: DemoScaffoldResult, timeline?: ReturnType<typeof createProgressTimeline>) => string;
    buildEmptyScaffold: (changeSet: any) => ReviewScaffold;
    buildScaffoldingClosure: (repoPath: string, pr: number, opts: any) => any;
    GITHUB_REPO_URL: string;
  };
  return mod;
}

export interface ReviewOptions {
  pr: number;
  repo: string;
  port?: number;
  open: boolean;
  json: boolean;
  refresh: boolean;
  process: boolean;
}

export function routeConsoleLogToStderr(): void {
  console.log = (...args: unknown[]) => {
    process.stderr.write(args.map(String).join(" ") + "\n");
  };
}

export function writeJsonOutput(output: unknown): void {
  process.stdout.write(JSON.stringify(output) + "\n");
}

export async function runReview(opts: ReviewOptions): Promise<void> {
  const { pr, repo, port: requestedPort, open: shouldOpen, json: jsonMode, refresh, process: eagerProcess } = opts;

  // The demo pipeline (scripts/demo-data.ts) logs its progress via console.log.
  // Route ALL console.log output to stderr for this process: stdout must stay
  // clean for --json, and progress uniformly lives on stderr in human mode too.
  // (scripts/serve-demo.ts is untouched — this only affects the sleek CLI.)
  routeConsoleLogToStderr();

  const timeline = createProgressTimeline({
    onStage: jsonMode ? undefined : printProgress,
  });

  if (!jsonMode) {
    process.stderr.write(`\nSleek review of PR #${pr} from ${repo}\n\n`);
  }

  mkdirSync(`${repo}/.sleek`, { recursive: true });
  const cache = openCache(`${repo}/.sleek/cache.db`);
  const store = openStore(`${repo}/.sleek/demo.db`);

  const { buildDemoScaffold, githubRepoUrl, renderDemoHtmlCached, buildEmptyScaffold, buildScaffoldingClosure, GITHUB_REPO_URL } = await importDemoData();

  try {
    const actualRepoUrl = await githubRepoUrl(repo);
    const repoUrl = actualRepoUrl ?? repo;
    const repoIdentity = actualRepoUrl ? parseRepoIdentity(actualRepoUrl) : undefined;
    const gh = createCachingGhRunner({
      cache,
      repoUrl,
      prNumber: pr,
      refresh,
      timeline,
      inner: defaultGhRunner,
    });

    // Explore-first default: ingest → check store → hit: serve full; miss: empty + scaffold closure
    // With --process flag: eager scaffold as before
    const changeSet = await ingestPr(pr, { cwd: repo, gh });
    const storedScaffold = store.getScaffold(pr, changeSet.pr.headSha);

    let reviewScaffold: ReviewScaffold;
    let html: string;

    if (eagerProcess || storedScaffold) {
      // Eager mode (--process) or store hit: build full scaffold eagerly
      const result = await buildDemoScaffold(repo, pr, { gh, store, timeline });
      reviewScaffold = result.reviewScaffold;
      html = renderDemoHtmlCached(cache, result, timeline);
    } else {
      // Explore-first (default): serve empty scaffold
      reviewScaffold = buildEmptyScaffold(changeSet);
      const prUrl = (await githubRepoUrl(repo)) ?? GITHUB_REPO_URL;
      html = renderReviewHtml(reviewScaffold, changeSet.unifiedDiff, {}, `${prUrl}/pull/${pr}`);
      timeline.add("render", 0, "empty (explore-first)");
    }

    const worktreeStart = performance.now();
    const lsp = await createWorktreeLsp(repo, reviewScaffold.pr.headSha);
    timeline.add(
      "worktree create",
      performance.now() - worktreeStart,
      lsp.reused ? "reused (pool)" : "created",
    );

    let closeServer: (() => Promise<void>) | undefined;
    let shuttingDown = false;
    let registeredServer: { url: string; repo: string; pr: number; headSha: string } | undefined;

    async function shutdown(opts: { exit: boolean; finish: boolean }): Promise<void> {
      if (shuttingDown) return;
      shuttingDown = true;

      if (registeredServer) {
        unregisterServer(registeredServer);
        registeredServer = undefined;
      }
      await closeServer?.().catch(() => {});
      await lsp.cleanup().catch(() => {});
      store.close();
      cache.close();

      if (opts.finish) {
        const plan = finishCleanupPlan({
          repo,
          headSha: reviewScaffold.pr.headSha,
          cacheDbPath: `${repo}/.sleek/cache.db`,
          worktreePath: lsp.worktreePath,
        });
        await applyFinishCleanup(plan, repo).catch((err) => {
          process.stderr.write(`Failed to finish cleanup: ${String(err)}\n`);
        });
      }

      if (opts.exit) process.exit(0);
    }

    const listenStart = performance.now();
    const server = await startServer({
      html,
      scaffold: reviewScaffold,
      prTitle: reviewScaffold.pr.title,
      port: requestedPort,
      lsp: lsp.manager,
      lspWorktree: lsp.worktreePath,
      store,
      contextReader: createFileContextReader(lsp.worktreePath),
      github: repoIdentity
        ? { ...repoIdentity, gh: defaultGhRunner, repoPath: repo }
        : undefined,
      finish: {
        available: true,
        run: async () => {
          process.stderr.write("\nFinishing review and cleaning disposable files...\n");
          await shutdown({ exit: true, finish: true });
        },
      },
      // Wave 7: scaffold capability for replay or anthropic
      scaffolding: buildScaffoldingClosure(repo, pr, { cache, store, timeline, gh }),
    });
    const { port, close } = server;
    closeServer = close;
    timeline.add("server listen", performance.now() - listenStart);

    const url = `http://localhost:${port}`;
    registeredServer = { url, repo, pr, headSha: reviewScaffold.pr.headSha };
    registerServer({
      ...registeredServer,
      startedAt: new Date().toISOString(),
    });

    // Probe Ollama (non-blocking: 1s timeout; warn only, never fail).
    probeOllama().catch(() => {}).then((alive) => {
      if (!alive) {
        process.stderr.write(
          "\nNote: Ollama is not running (chat/ask will be unavailable).\n" +
          "  Start it with:  ollama serve\n",
        );
      }
    });

    if (jsonMode) {
      const output = {
        pr,
        headSha: reviewScaffold.pr.headSha,
        port,
        url,
        stages: timeline.entries(),
      };
      writeJsonOutput(output);
    } else {
      process.stderr.write(`\n${timeline.table()}\n`);
      process.stderr.write(`\nSleek review of PR #${pr} → ${url}\n`);
    }

    if (shouldOpen && process.platform === "darwin") {
      execFile("open", [url], () => {});
    }

    process.once("SIGINT", () => {
      void shutdown({ exit: true, finish: false });
    });
    process.once("SIGTERM", () => {
      void shutdown({ exit: true, finish: false });
    });

    // Keep the process alive (server is running).
  } catch (err) {
    store.close();
    cache.close();

    if (err instanceof IngestError) {
      const friendly = friendlyIngestError(err.kind, { prNumber: pr, repoPath: repo });
      process.stderr.write(formatFriendlyError(friendly) + "\n");
      process.exit(friendly.exitCode);
    }

    // In eager mode, buildDemoScaffold may throw for unknown PRs with no authored review
    if (eagerProcess && err instanceof Error && err.message.includes("No authored review for PR")) {
      const friendly = friendlyMissingReviewError(pr, repo);
      process.stderr.write(formatFriendlyError(friendly) + "\n");
      process.exit(friendly.exitCode);
    }

    // Unexpected errors
    process.stderr.write(`Unexpected error: ${String(err)}\n`);
    if (err instanceof Error && err.stack) {
      process.stderr.write(err.stack + "\n");
    }
    process.exit(2);
  }
}

/** Probe Ollama with a ~1s timeout. Returns true if responsive. */
async function probeOllama(): Promise<boolean> {
  const host = process.env.OLLAMA_HOST ?? "http://localhost:11434";
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 1000);
    try {
      const res = await fetch(`${host}/api/version`, { signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}
