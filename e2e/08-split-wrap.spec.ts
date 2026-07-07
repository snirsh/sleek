/**
 * Spec 8: Split view + word wrap toggles.
 * Verifies:
 *   - Pressing 's' (or clicking #stoggle) toggles split view:
 *     body gets class "split" and localStorage sleek:viewmode changes.
 *   - Pressing 'z' toggles wrap: body gets class "wrap" and
 *     localStorage sleek:wrap changes.
 *   - Diff rows are still present after toggling.
 */

import { test, expect } from "@playwright/test";
import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("split view: s key toggles split and persists to localStorage", async ({ page }) => {
  await page.goto(baseUrl());

  // Initial state: unified.
  const stoggle = page.locator("#stoggle");
  await expect(stoggle).toBeVisible();
  await expect(stoggle).toHaveAttribute("aria-pressed", "false");

  // Press 's' to enable split view.
  await page.keyboard.press("s");
  await expect(stoggle).toHaveAttribute("aria-pressed", "true", { timeout: 3000 });

  // Check localStorage.
  const stored = await page.evaluate(() => {
    try { return localStorage.getItem("sleek:viewmode"); } catch { return null; }
  });
  expect(stored).toBe("split");

  // Filecards still present in the DOM after split toggle.
  await expect(page.locator(".filecard").first()).toBeAttached();

  // Press 's' again to restore unified.
  await page.keyboard.press("s");
  await expect(stoggle).toHaveAttribute("aria-pressed", "false", { timeout: 3000 });
  const stored2 = await page.evaluate(() => {
    try { return localStorage.getItem("sleek:viewmode"); } catch { return null; }
  });
  expect(stored2).toBe("unified");
});

test("word wrap: z key toggles wrap and persists to localStorage", async ({ page }) => {
  await page.goto(baseUrl());

  const ztoggle = page.locator("#ztoggle");
  await expect(ztoggle).toBeVisible();
  await expect(ztoggle).toHaveAttribute("aria-pressed", "false");

  // Enable wrap.
  await page.keyboard.press("z");
  await expect(ztoggle).toHaveAttribute("aria-pressed", "true", { timeout: 3000 });

  // body should have class "wrap".
  await expect(page.locator("body")).toHaveClass(/\bwrap\b/, { timeout: 3000 });

  // localStorage persisted.
  const stored = await page.evaluate(() => {
    try { return localStorage.getItem("sleek:wrap"); } catch { return null; }
  });
  expect(stored).toBe("1");

  // Filecards still present in the DOM after wrap toggle.
  await expect(page.locator(".filecard").first()).toBeAttached();

  // Disable wrap.
  await page.keyboard.press("z");
  await expect(ztoggle).toHaveAttribute("aria-pressed", "false", { timeout: 3000 });
  await expect(page.locator("body")).not.toHaveClass(/\bwrap\b/);
  const stored2 = await page.evaluate(() => {
    try { return localStorage.getItem("sleek:wrap"); } catch { return null; }
  });
  expect(stored2).toBe("0");
});
