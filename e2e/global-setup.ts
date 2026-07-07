/**
 * Playwright global setup: spin up a throwaway demo server for e2e tests.
 *
 * Configuration (env vars — the suite SKIPS cleanly when they are unset):
 *  - SLEEK_E2E_REPO   absolute path to a local git checkout with a GitHub origin
 *  - SLEEK_E2E_PR     a PR number in that repo. An authored review MUST exist at
 *                     scripts/reviews/<pr>.json (see scripts/reviews/README.md and
 *                     the format docs in scripts/demo-data.ts) — the demo server
 *                     replays it as the review content the specs assert against.
 *  - SLEEK_E2E_STORE_ROOT (optional) checkout whose pre-seeded .sleek/ store is
 *                     copied into the scratch cwd; defaults to this checkout.
 *  - Spec 13 additionally reads SLEEK_E2E_BIG_REPO / SLEEK_E2E_BIG_PR (a large
 *    PR, >40 changed files) and skips on its own when those are unset.
 *
 * Strategy:
 *  - Create a temp dir (os.tmpdir() / sleek-e2e-XXXXXX)
 *  - Copy the store root's .sleek/ directory into it so the server gets a warm
 *    store (the chosen PR's scaffold should be pre-seeded in demo.db)
 *  - Spawn `tsx scripts/serve-demo.ts <repoPath> <prNumber> <port>` with cwd = temp
 *  - Poll /api/health until it responds ok (max 60 s)
 *  - Write the base URL to process.env so specs can read it
 *
 * The E2E_SCRATCH_DIR env var is set here so teardown can locate the temp dir.
 */

import { execSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { E2E_REPO, E2E_SKIP_MESSAGE, PR_NUMBER, e2eConfigured } from "./fixtures.ts";

// Run the CODE UNDER TEST: serve-demo from this checkout (the worktree Playwright
// was launched in), so e2e exercises local render/client changes — not a sibling
// checkout. The pre-seeded scaffold store comes from STORE_ROOT/.sleek (copied
// into a scratch cwd so the real demo.db is never written).
const REPO_ROOT = process.cwd();
const STORE_ROOT = process.env["SLEEK_E2E_STORE_ROOT"] ?? REPO_ROOT;

// Pick a port in 63777-63799 range that isn't in use.
function pickPort(): number {
  // Start at 63788 (specified in brief), fall back in range if taken.
  for (let p = 63788; p <= 63799; p++) {
    try {
      execSync(`lsof -ti tcp:${p}`, { stdio: "pipe" });
      // Port in use — try next.
    } catch {
      // lsof exits non-zero when port is free.
      return p;
    }
  }
  throw new Error("No free port found in 63777-63799 range");
}

export default async function globalSetup(): Promise<void> {
  if (!e2eConfigured) {
    // Every spec guards on e2eConfigured and skips itself; just don't boot a server.
    console.log(`[e2e setup] skipping server boot — ${E2E_SKIP_MESSAGE}`);
    return;
  }

  // Create a fresh scratch dir so the real .sleek/demo.db is never written.
  const scratchDir = mkdtempSync(join(tmpdir(), "sleek-e2e-"));

  // Copy the pre-seeded .sleek/ (demo.db + cache.db) into the scratch dir.
  cpSync(join(STORE_ROOT, ".sleek"), join(scratchDir, ".sleek"), { recursive: true });

  const port = pickPort();
  const baseUrl = `http://localhost:${port}`;

  // Use the repo's own tsx binary: `npx tsx` from the scratch cwd (no package.json)
  // does a cold registry roundtrip on every run (~70 s, past the 60 s readiness
  // deadline) because there is no local install for npx to resolve against.
  const child = spawn(
    join(REPO_ROOT, "node_modules/.bin/tsx"),
    [join(REPO_ROOT, "scripts/serve-demo.ts"), E2E_REPO!, String(PR_NUMBER), String(port)],
    {
      cwd: scratchDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
      env: {
        ...process.env,
        // Suppress SLEEK_REFRESH so we only hit cache.
        SLEEK_REFRESH: "0",
      },
    },
  );

  // Capture server logs for debugging on failure.
  let serverLog = "";
  child.stdout.on("data", (d: Buffer) => { serverLog += d.toString(); });
  child.stderr.on("data", (d: Buffer) => { serverLog += d.toString(); });

  child.on("error", (e) => {
    console.error("[e2e setup] server spawn error:", e);
  });

  // Poll /api/health until ok or timeout.
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const json = await res.json() as { ok?: boolean };
        if (json.ok) { ready = true; break; }
      }
    } catch {
      // Not ready yet — wait and retry.
    }
    await new Promise<void>((r) => setTimeout(r, 500));
  }

  if (!ready) {
    child.kill("SIGTERM");
    console.error("[e2e setup] server log:\n", serverLog);
    throw new Error(`Demo server on ${baseUrl} never became ready within 60 s`);
  }

  console.log(`[e2e setup] server ready at ${baseUrl} (cwd: ${scratchDir})`);

  // Expose via process.env so tests can read BASE_URL.
  process.env["E2E_BASE_URL"] = baseUrl;
  process.env["E2E_SCRATCH_DIR"] = scratchDir;
  // Store the child PID for teardown.
  process.env["E2E_SERVER_PID"] = String(child.pid);
}
