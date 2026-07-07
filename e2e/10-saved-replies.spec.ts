/**
 * Spec 10: Saved replies.
 * Verifies:
 *   - The composer has a "Saved replies" button when live mode + replies enabled.
 *   - POST /api/replies creates a reply.
 *   - The reply appears in the dropdown when opened.
 *   - Clicking it inserts text into the composer textarea.
 *
 * Requires health.threads && health.replies.
 * Cleans up created replies via DELETE /api/replies/:id.
 */

import { test, expect } from "@playwright/test";
import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("saved replies: button present in composer and reply inserts at caret", async ({ page }) => {
  const health = await (await fetch(`${baseUrl()}/api/health`)).json() as {
    threads?: boolean;
    replies?: boolean;
  };
  if (!health.threads || !health.replies) {
    test.skip();
    return;
  }

  // Create a test saved reply via the API.
  const title = `e2e-test-reply-${Date.now()}`;
  const body = "This is an e2e test saved reply body.";
  const createRes = await fetch(`${baseUrl()}/api/replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });
  expect(createRes.status).toBe(201);
  const created = await createRes.json() as { id: number };
  const replyId = created.id;

  try {
    await page.goto(baseUrl());

    // Select a diff line to enable the composer.
    const diffRow = page.locator(".filecard .row.add, .filecard .row.del, .filecard .row.ctx").first();
    await diffRow.waitFor({ state: "visible" });
    const gn = diffRow.locator("td.gn");
    const go = diffRow.locator("td.go");
    await (await gn.count() > 0 ? gn : go).click();

    const abar = page.locator("#abar");
    await expect(abar).toBeVisible({ timeout: 5000 });

    // Open composer via 'c' key.
    await page.keyboard.press("c");
    const composer = page.locator(".composer");
    await expect(composer).toBeVisible({ timeout: 5000 });

    // "Saved replies" button should exist in the composer.
    const repliesBtn = composer.locator("button", { hasText: "Saved replies" });
    await expect(repliesBtn).toBeVisible({ timeout: 5000 });

    // Click to open the saved-replies dropdown.
    await repliesBtn.click();

    // A panel or dropdown containing the reply title should appear.
    // The saved-replies panel is a fixed dropdown (class rpanel or similar).
    // We look for the reply title text anywhere in the page.
    const replyTitleEl = page.locator("text=" + title).first();
    await expect(replyTitleEl).toBeVisible({ timeout: 5000 });

    // Click the reply to insert it.
    await replyTitleEl.click();

    // The textarea should now contain the body text.
    const textarea = composer.locator("textarea");
    await expect(textarea).toHaveValue(body, { timeout: 3000 });
  } finally {
    // Clean up: delete the created saved reply.
    await fetch(`${baseUrl()}/api/replies/${replyId}`, { method: "DELETE" });
  }
});
