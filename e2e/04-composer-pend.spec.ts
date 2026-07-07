/**
 * Spec 4: Comment composer → pending bar.
 * Verifies: with a line selection, pressing "c" opens the composer;
 * typing text and submitting creates a pending comment; the pending bar
 * appears with a count of ≥1.
 *
 * The composer is live-mode only (health.threads must be true). We poll
 * /api/health first and skip if threads are unavailable.
 */

import { test, expect } from "@playwright/test";
import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("composer: open via c key and submit pending comment", async ({ page }) => {
  // Check threads available.
  const health = await (await fetch(`${baseUrl()}/api/health`)).json() as { threads?: boolean };
  if (!health.threads) {
    test.skip();
    return;
  }

  await page.goto(baseUrl());

  // Select a diff line.
  const diffRow = page.locator(".filecard .row.add, .filecard .row.del, .filecard .row.ctx").first();
  await diffRow.waitFor({ state: "visible" });
  const gn = diffRow.locator("td.gn");
  const go = diffRow.locator("td.go");
  const hasGn = await gn.count() > 0;
  await (hasGn ? gn : go).click();

  const abar = page.locator("#abar");
  await expect(abar).toBeVisible({ timeout: 5000 });

  // Make the Comment button visible: it's shown when live + selection exists.
  const commentBtn = page.locator("#comment-sel");
  // It may be hidden initially; pressing 'c' should open the composer directly.
  await page.keyboard.press("c");

  // Composer should appear: a div.composer with a textarea.
  const composer = page.locator(".composer");
  await expect(composer).toBeVisible({ timeout: 5000 });

  const textarea = composer.locator("textarea");
  await expect(textarea).toBeFocused({ timeout: 3000 });

  // Type a comment.
  await textarea.fill("e2e smoke test comment — please ignore");

  // Submit via the Comment button.
  const goBtn = composer.locator("button.askbtn").filter({ hasText: "Comment" });
  await expect(goBtn).toBeEnabled();
  await goBtn.click();

  // After submit, pending bar should appear with pending count ≥ 1.
  const pendbar = page.locator("#pendbar");
  await expect(pendbar).toBeVisible({ timeout: 8000 });

  const pendLabel = page.locator("#pend-label");
  await expect(pendLabel).toContainText("pending", { timeout: 5000 });
});
