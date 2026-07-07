/**
 * Spec 12 — Wave-9 client reattach UX (9C Playwright proof).
 *
 * Tests run against a throwaway stub server on port 63777 that implements the
 * frozen Wave-9 scaffold protocol. The stub is managed here via beforeAll /
 * afterAll — completely independent of the global demo-server setup.
 *
 * Scenarios:
 *   (a) Run starts and chip shows progress.
 *   (b) Mid-run stream drop → client reattaches with ?since=<N> and finishes.
 *   (c) Mid-run page reload → chip restored and run completes.
 *   (d) Cancel → "Cancelled." chip.
 *   (e) No uncaught console errors throughout.
 */

import { test, expect } from "@playwright/test";
import { e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";
import type { Page } from "@playwright/test";
import { startStub } from "./scaffold-stub.ts";
import type { StubHandle } from "./scaffold-stub.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

const STUB_PORT = 63777;
// Drop the first stream after seq 3 (after ingest-done, before skeleton-done).
// The client should reattach and complete normally.
const DROP_AFTER_SEQ = 3;

// Each test in this file gets its own stub instance to avoid state bleed.
// We serialise tests (workers:1 in playwright.config.ts) so port reuse is safe.

async function withStub(
  envOverrides: Record<string, string>,
  fn: (stub: StubHandle, baseUrl: string) => Promise<void>,
): Promise<void> {
  // Apply env overrides for this stub instance.
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const stub = await startStub(STUB_PORT);
  try {
    await fn(stub, stub.baseUrl);
  } finally {
    await stub.close();
    for (const [k] of Object.entries(envOverrides)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Wait up to `ms` for the chip label to contain `text`. */
async function waitForChipText(page: Page, text: string, ms = 15000): Promise<void> {
  const label = page.locator("#procchip-label");
  await expect(label).toContainText(text, { timeout: ms });
}

/** Assert the chip is visible. */
async function expectChipVisible(page: Page): Promise<void> {
  await expect(page.locator("#procchip")).toBeVisible({ timeout: 8000 });
}

/** Click the Process PR button and start a run by choosing the stub provider. */
async function startRun(page: Page): Promise<void> {
  // Wait for /api/models to populate the picker choices. The review.html serves an
  // existing scaffold (layers > 0) so processButtonVisible() hides the button; we
  // force it visible via JS after choices are ready.
  //
  // Wait for at least one non-disabled radio to appear inside proc-choices (set by
  // renderChoices after /api/models returns). This avoids fixed-timeout races.
  await page.waitForFunction((): boolean => {
    const choices = document.getElementById("proc-choices");
    if (!choices) return false;
    return choices.querySelector("input[name='scaffolder']:not(:disabled)") !== null;
  }, undefined, { timeout: 10000 });

  // Force the button visible (layers.length > 0 gates it off).
  await page.evaluate((): void => {
    const btn = document.getElementById("procpr") as HTMLButtonElement | null;
    if (btn) { btn.hidden = false; btn.disabled = false; }
  });

  // Click "Process PR" button to open the picker modal.
  const btn = page.locator("#procpr");
  await expect(btn).toBeVisible({ timeout: 3000 });
  await btn.click();

  // The modal should open; the radio buttons are already rendered.
  const modal = page.locator("#procwrap");
  await expect(modal).toBeVisible({ timeout: 5000 });

  // Select the first non-disabled radio.
  const radio = modal.locator("input[name=scaffolder]:not(:disabled)").first();
  await expect(radio).toBeVisible({ timeout: 5000 });
  await radio.check();

  // Click Start.
  const goBtn = modal.locator("#proc-go");
  await goBtn.click();

  // Modal should close, chip should appear.
  await expect(modal).toBeHidden({ timeout: 5000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe("scaffold reattach UX (9C)", () => {
  // Collect console errors per test.
  let consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      consoleErrors.push("pageerror: " + err.message);
    });
  });

  test("(a) run starts and chip shows progress", async ({ page }) => {
    await withStub({
      STUB_HB_MS: "500",
      STUB_EVENT_MS: "300",
    }, async (stub, baseUrl) => {
      await page.goto(baseUrl + "/");

      await startRun(page);

      // Chip should appear with progress text.
      await expectChipVisible(page);
      await waitForChipText(page, "Processing");

      // Wait for the run to finish (chip shows "Scaffold ready").
      // The client triggers location.reload() 1200ms after "done" — we assert
      // before the reload fires; there is a ~1.2s window which is ample.
      await waitForChipText(page, "Scaffold ready", 20000);

      // No uncaught errors.
      const errs = consoleErrors.filter((e) =>
        !e.includes("favicon") && !e.includes("net::ERR")
      );
      expect(errs, "console errors: " + errs.join("; ")).toHaveLength(0);
    });
  });

  test("(b) mid-run stream drop -> client reattaches with since= and finishes", async ({ page }) => {
    // The stub will drop the first stream after seq DROP_AFTER_SEQ.
    await withStub({
      STUB_HB_MS: "500",
      STUB_EVENT_MS: "300",
      STUB_DROP_AFTER_SEQ: String(DROP_AFTER_SEQ),
    }, async (stub, baseUrl) => {
      // Track ?since= values received on /api/scaffold/stream.
      const sinceValues: number[] = [];
      // We intercept by checking the URL on the page-level request event.
      page.on("request", (req) => {
        const u = req.url();
        if (u.includes("/api/scaffold/stream")) {
          const match = u.match(/since=(-?\d+)/);
          if (match) sinceValues.push(parseInt(match[1], 10));
        }
      });

      await page.goto(baseUrl + "/");
      await startRun(page);

      await expectChipVisible(page);

      // Run eventually finishes — chip shows "Scaffold ready".
      // (The "Reconnecting" flash may be too brief to catch in a poll; we verify
      // correct behaviour via the since= request check below instead.)
      // Assert before the 1200ms reload window closes.
      await waitForChipText(page, "Scaffold ready", 25000);

      // The reattach request must have included a since= >= 0 (client tracked lastSeq
      // from the events it received before the drop).
      const reattachReqs = sinceValues.filter((s) => s >= 0);
      expect(reattachReqs.length, "expected at least one reattach request with since>=0").toBeGreaterThan(0);

      const errs = consoleErrors.filter((e) =>
        !e.includes("favicon") && !e.includes("net::ERR")
      );
      expect(errs, "console errors: " + errs.join("; ")).toHaveLength(0);
    });
  });

  test("(c) mid-run page reload -> chip restored and run completes", async ({ page }) => {
    // Use a slow run so the reload happens mid-run.
    await withStub({
      STUB_HB_MS: "500",
      STUB_EVENT_MS: "800",
    }, async (stub, baseUrl) => {
      await page.goto(baseUrl + "/");
      await startRun(page);

      // Wait for the chip to show Processing (run is started).
      await waitForChipText(page, "Processing", 10000);

      // Wait a moment so some events have been sent, then reload.
      await page.waitForTimeout(1000);
      await page.reload();

      // After reload, the page-load status probe should detect the running job
      // and restore the chip automatically.
      await expectChipVisible(page);
      await waitForChipText(page, "Processing", 8000);

      // Run eventually finishes.
      await waitForChipText(page, "Scaffold ready", 25000);

      const errs = consoleErrors.filter((e) =>
        !e.includes("favicon") && !e.includes("net::ERR")
      );
      expect(errs, "console errors: " + errs.join("; ")).toHaveLength(0);
    });
  });

  test("(d) cancel -> Cancelled. chip", async ({ page }) => {
    // Use a slow run so we can cancel mid-run.
    await withStub({
      STUB_HB_MS: "300",
      STUB_EVENT_MS: "800",
    }, async (stub, baseUrl) => {
      await page.goto(baseUrl + "/");
      await startRun(page);

      // Wait for chip to show progress.
      await waitForChipText(page, "Processing", 10000);

      // Wait for at least 2 fake events to be delivered (ensures stream is active).
      await page.waitForTimeout(2000);

      const chipX = page.locator("#procchip-x");
      await expect(chipX).toBeVisible({ timeout: 5000 });
      await chipX.click();

      // Chip should show "Cancelling..." then "Cancelled."
      await waitForChipText(page, "Cancelled.", 15000);

      const errs = consoleErrors.filter((e) =>
        !e.includes("favicon") && !e.includes("net::ERR")
      );
      expect(errs, "console errors: " + errs.join("; ")).toHaveLength(0);
    });
  });
});
