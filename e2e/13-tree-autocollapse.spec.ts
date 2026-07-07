/**
 * Spec 13: big-PR auto-collapse.
 *
 * The shared e2e server (a small PR, a handful of files) can't exercise the
 * >40-file auto-collapse path, so this spec boots its OWN throwaway demo server
 * against a LARGE PR — same recipe as global-setup — and tears it down
 * afterwards. The real .sleek/demo.db is never written (cwd = a scratch copy).
 *
 * Configuration (skips cleanly when unset):
 *   SLEEK_E2E_BIG_REPO  local checkout containing a large PR (>40 changed files)
 *   SLEEK_E2E_BIG_PR    that PR's number; scripts/reviews/<pr>.json must exist
 */

import { test, expect } from "@playwright/test";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd(); // run the code under test (this worktree)
// Pre-seeded scaffold store (see global-setup.ts).
const STORE_ROOT = process.env["SLEEK_E2E_STORE_ROOT"] ?? REPO_ROOT;
const BIG_REPO = process.env["SLEEK_E2E_BIG_REPO"];
const BIG_PR = Number(process.env["SLEEK_E2E_BIG_PR"] ?? "0");

test.skip(
  !BIG_REPO || !(BIG_PR > 0),
  "big-PR e2e not configured: set SLEEK_E2E_BIG_REPO and SLEEK_E2E_BIG_PR " +
    "(a PR with >40 changed files and an authored review at scripts/reviews/<pr>.json)",
);

function pickPort(): number {
  for (let p = 63790; p <= 63799; p++) {
    try {
      execSync(`lsof -ti tcp:${p}`, { stdio: "pipe" });
    } catch {
      return p; // lsof non-zero => port free
    }
  }
  throw new Error("no free port in 63790-63799");
}

let child: ChildProcess | undefined;
let scratchDir = "";
let base = "";

test.beforeAll(async () => {
  scratchDir = mkdtempSync(join(tmpdir(), "sleek-e2e-big-"));
  cpSync(join(STORE_ROOT, ".sleek"), join(scratchDir, ".sleek"), { recursive: true });
  const port = pickPort();
  base = `http://localhost:${port}`;
  child = spawn(
    "npx",
    ["tsx", join(REPO_ROOT, "scripts/serve-demo.ts"), BIG_REPO!, String(BIG_PR), String(port)],
    { cwd: scratchDir, stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, SLEEK_REFRESH: "0" } },
  );
  // Poll health up to 60s.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("big-PR demo server never became healthy");
    await new Promise((res) => setTimeout(res, 1000));
  }
});

test.afterAll(async () => {
  if (child && child.pid) {
    try {
      // Negative pid = kill the whole process group (kills npx + the spawned tsx/node child).
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
    }
  }
  if (scratchDir) {
    try {
      rmSync(scratchDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test("big PR (>40 files) auto-collapses non-top-level dirs on first load", async ({ page }) => {
  await page.goto(base);
  await expect(page.locator("#filesec")).toBeVisible();

  const info = await page.evaluate(() => {
    const dirs = [...document.querySelectorAll(".tdbtn")];
    const collapsed = dirs.filter((d) => d.getAttribute("aria-expanded") === "false").length;
    const fileCount = document.querySelectorAll("li.tf").length;
    return { total: dirs.length, collapsed, fileCount };
  });

  // Sanity: this really is the big PR.
  expect(info.fileCount).toBeGreaterThan(40);
  // The large majority of dirs start collapsed (landmark view).
  expect(info.collapsed).toBeGreaterThan(info.total * 0.5);
});

test("ancestors of finding-bearing files stay expanded through auto-collapse", async ({ page }) => {
  await page.goto(base);
  // Any dir that still shows a findings chip inside a visible file row must be
  // expanded (its subtree is reachable), proving findings ancestors were spared.
  const finding = page.locator("li.tdir:has(.tkids:not([hidden]) li.tf .ffind)").first();
  await expect(finding).toBeAttached();
  const expanded = finding.locator("> .tdbtn");
  await expect(expanded).toHaveAttribute("aria-expanded", "true");
});
