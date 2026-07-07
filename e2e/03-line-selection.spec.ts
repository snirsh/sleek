/**
 * Spec 3: Line selection mechanics.
 * Verifies: clicking a diff gutter cell selects a line (abar appears);
 * shift-clicking extends the selection; Esc clears it.
 *
 * NOTE: The gutter cells are td.gn / td.go (new/old line number cells).
 * They are user-select:none in CSS but are still click targets.
 * The abar (#abar) is hidden until a selection exists.
 */

import { test, expect } from "@playwright/test";
import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("line selection: clicking a gutter makes abar visible", async ({ page }) => {
  await page.goto(baseUrl());

  // Make sure at least one non-hunk diff row is visible.
  // Load the first filecard if it's collapsed.
  const firstCard = page.locator(".filecard").first();
  const isCollapsed = await firstCard.evaluate((el) => el.classList.contains("collapsed"));
  if (isCollapsed) {
    // The guard button loads the diff.
    const loadBtn = firstCard.locator(".loaddiff");
    if (await loadBtn.isVisible()) await loadBtn.click();
    else {
      const collapseBtn = firstCard.locator(".collapse");
      if (await collapseBtn.isVisible()) await collapseBtn.click();
    }
  }

  // Find the first add or del row (not hunk header).
  const diffRow = page.locator(".filecard .row.add, .filecard .row.del, .filecard .row.ctx").first();
  await expect(diffRow).toBeVisible();

  // Click the new-line gutter (td.gn) — if present. Fall back to old-line gutter.
  const gn = diffRow.locator("td.gn");
  const go = diffRow.locator("td.go");
  const hasGn = await gn.count() > 0;
  await (hasGn ? gn : go).click();

  // Selection bar (#abar) should become visible.
  const abar = page.locator("#abar");
  await expect(abar).toBeVisible({ timeout: 5000 });
});

test("line selection: Esc clears the selection", async ({ page }) => {
  await page.goto(baseUrl());

  // Select a line.
  const diffRow = page.locator(".filecard .row.add, .filecard .row.del, .filecard .row.ctx").first();
  await diffRow.waitFor({ state: "visible" });

  const gn = diffRow.locator("td.gn");
  const go = diffRow.locator("td.go");
  const hasGn = await gn.count() > 0;
  await (hasGn ? gn : go).click();

  const abar = page.locator("#abar");
  await expect(abar).toBeVisible({ timeout: 5000 });

  // Press Escape — clears selection.
  await page.keyboard.press("Escape");
  await expect(abar).toBeHidden({ timeout: 3000 });
});

test("line selection: shift-click on a second row extends selection", async ({ page }) => {
  await page.goto(baseUrl());

  const rows = page.locator(".filecard .row.add, .filecard .row.del, .filecard .row.ctx");
  await rows.first().waitFor({ state: "visible" });
  const count = await rows.count();
  if (count < 2) {
    test.skip();
    return;
  }

  const firstRow = rows.nth(0);
  const secondRow = rows.nth(1);

  const gnFirst = firstRow.locator("td.gn");
  const goFirst = firstRow.locator("td.go");
  const hasGnFirst = await gnFirst.count() > 0;
  await (hasGnFirst ? gnFirst : goFirst).click();

  const abar = page.locator("#abar");
  await expect(abar).toBeVisible({ timeout: 5000 });

  // Shift-click the second row.
  const gnSecond = secondRow.locator("td.gn");
  const goSecond = secondRow.locator("td.go");
  const hasGnSecond = await gnSecond.count() > 0;
  await (hasGnSecond ? gnSecond : goSecond).click({ modifiers: ["Shift"] });

  // abar should still be visible (selection extended, not cleared).
  await expect(abar).toBeVisible();
});
