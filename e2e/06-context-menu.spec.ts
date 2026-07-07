/**
 * Spec 6: Context menu (Wave 8).
 * Verifies: right-clicking a diff row opens a .diffmenu; the menu contains
 * a "Copy path:line" item; Esc dismisses the menu.
 *
 * We do NOT click "See source" (would open an editor). We assert on DOM
 * structure only, not clipboard content (which requires permissions).
 */

import { test, expect } from "@playwright/test";
import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("context menu: right-click diff row shows menu with Copy path:line", async ({ page }) => {
  await page.goto(baseUrl());

  // Find a non-hunk diff row.
  const diffRow = page.locator(".filecard .row.add, .filecard .row.del, .filecard .row.ctx").first();
  await expect(diffRow).toBeVisible();

  // Right-click the row.
  await diffRow.click({ button: "right" });

  // The .diffmenu should appear.
  const menu = page.locator(".diffmenu");
  await expect(menu).toBeVisible({ timeout: 5000 });

  // Must contain a "Copy path:line" button.
  const copyItem = menu.locator(".dmitem", { hasText: "Copy path:line" });
  await expect(copyItem).toBeVisible();
});

test("context menu: Esc dismisses the menu", async ({ page }) => {
  await page.goto(baseUrl());

  const diffRow = page.locator(".filecard .row.add, .filecard .row.del, .filecard .row.ctx").first();
  await expect(diffRow).toBeVisible();
  await diffRow.click({ button: "right" });

  const menu = page.locator(".diffmenu");
  await expect(menu).toBeVisible({ timeout: 5000 });

  // Esc is first in the chain — closes context menu.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden({ timeout: 3000 });
});

test("context menu: menu has a GitHub permalink item when live", async ({ page }) => {
  const health = await (await fetch(`${baseUrl()}/api/health`)).json() as {
    actions?: { permalink?: string | null };
  };

  await page.goto(baseUrl());

  const diffRow = page.locator(".filecard .row.add, .filecard .row.del, .filecard .row.ctx").first();
  await expect(diffRow).toBeVisible();
  await diffRow.click({ button: "right" });

  const menu = page.locator(".diffmenu");
  await expect(menu).toBeVisible({ timeout: 5000 });

  if (health.actions?.permalink) {
    // Full live mode: permalink item present.
    const permaItem = menu.locator(".dmitem", { hasText: "Copy GitHub permalink" });
    await expect(permaItem).toBeVisible();
  } else {
    // No permalink configured — just assert the menu itself appeared.
    const items = menu.locator(".dmitem");
    await expect(items.first()).toBeVisible();
  }

  // Clean up.
  await page.keyboard.press("Escape");
});
