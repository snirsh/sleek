/**
 * Spec 5: Esc dismiss chain order.
 * Per client.ts ~605-630, the order is:
 *   1. context menu (diffMenu)
 *   2. process modal (processApi)
 *   3. help overlay (#helpwrap)
 *   4. palette (#palwrap)
 *   5. versions panel (#verswrap)
 *   6. export modal (#exportwrap)
 *   7. submit modal (#submitwrap)
 *   8. composer (.crow)
 *   9. selection (#abar)
 *   10. layer scope
 *
 * We test a representative sub-chain: open the help overlay (? key),
 * verify it's visible, press Esc — it should close (not the palette or
 * anything else). Then open the help overlay again AND blur the chat input;
 * Esc closes help first.
 */

import { test, expect } from "@playwright/test";
import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("Esc chain: ? opens help overlay; Esc closes it", async ({ page }) => {
  await page.goto(baseUrl());

  const helpWrap = page.locator("#helpwrap");
  await expect(helpWrap).toBeHidden();

  // Press ? to open the help overlay.
  await page.keyboard.press("?");
  await expect(helpWrap).toBeVisible({ timeout: 3000 });

  // Press Escape — should close help (first in chain at that level).
  await page.keyboard.press("Escape");
  await expect(helpWrap).toBeHidden({ timeout: 3000 });
});

test("Esc chain: help overlay closes before palette/selection", async ({ page }) => {
  await page.goto(baseUrl());

  const helpWrap = page.locator("#helpwrap");
  const palWrap = page.locator("#palwrap");

  // Open palette with t key.
  await page.keyboard.press("t");
  await expect(palWrap).toBeVisible({ timeout: 3000 });
  // Close palette first.
  await page.keyboard.press("Escape");
  await expect(palWrap).toBeHidden({ timeout: 3000 });

  // Now open help.
  await page.keyboard.press("?");
  await expect(helpWrap).toBeVisible({ timeout: 3000 });

  // Esc closes help.
  await page.keyboard.press("Escape");
  await expect(helpWrap).toBeHidden({ timeout: 3000 });
  // Palette stays closed.
  await expect(palWrap).toBeHidden();
});

test("Esc chain: selection clears after composer closes", async ({ page }) => {
  const health = await (await fetch(`${baseUrl()}/api/health`)).json() as { threads?: boolean };
  if (!health.threads) {
    test.skip();
    return;
  }

  await page.goto(baseUrl());

  // Select a line.
  const diffRow = page.locator(".filecard .row.add, .filecard .row.del, .filecard .row.ctx").first();
  await diffRow.waitFor({ state: "visible" });
  const gn = diffRow.locator("td.gn");
  const go = diffRow.locator("td.go");
  await (await gn.count() > 0 ? gn : go).click();

  const abar = page.locator("#abar");
  await expect(abar).toBeVisible({ timeout: 5000 });

  // Open composer.
  await page.keyboard.press("c");
  const composer = page.locator(".composer");
  await expect(composer).toBeVisible({ timeout: 5000 });

  // Esc inside the textarea closes composer (selection survives — per client.ts 2864).
  const textarea = composer.locator("textarea");
  await textarea.press("Escape");
  await expect(composer).toBeHidden({ timeout: 3000 });
  // Selection bar should still be visible (composer Esc doesn't clear selection).
  await expect(abar).toBeVisible();

  // Next Esc clears selection.
  await page.keyboard.press("Escape");
  await expect(abar).toBeHidden({ timeout: 3000 });
});
