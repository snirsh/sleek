/**
 * Spec 1: Page loads correctly.
 * Verifies: topbar shows PR number/title, file tree renders with items,
 * diff rows are present, and /api/health returns ok.
 */

import { test, expect } from "@playwright/test";
import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE, PR_NUMBER } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("page load: topbar PR number and title are visible", async ({ page }) => {
  await page.goto(baseUrl());
  // The topbar h1 contains a .prno span with "#<pr>" and the PR title.
  const prno = page.locator(".topbar h1 .prno");
  await expect(prno).toContainText(String(PR_NUMBER));
  // Title text is non-empty.
  const h1 = page.locator(".topbar h1");
  await expect(h1).not.toBeEmpty();
});

test("page load: file tree has at least one file item", async ({ page }) => {
  await page.goto(baseUrl());
  // File tree items have class .tf
  const treeItems = page.locator(".tf");
  await expect(treeItems.first()).toBeVisible();
});

test("page load: diff rows are present in the center pane", async ({ page }) => {
  await page.goto(baseUrl());
  // Diff rows have class .row (add/del/ctx) inside .filecard
  const rows = page.locator(".filecard .row").first();
  await expect(rows).toBeVisible();
});

test("page load: /api/health returns ok:true", async ({ request }) => {
  const res = await request.get(`${baseUrl()}/api/health`);
  expect(res.ok()).toBe(true);
  const body = await res.json() as { ok?: boolean };
  expect(body.ok).toBe(true);
});

test("page load: rail (reading order) has at least one layer", async ({ page }) => {
  await page.goto(baseUrl());
  const rail = page.locator("#rail");
  await expect(rail).toBeVisible();
  // Layer items inside the rail list
  const items = rail.locator("ul > li").first();
  await expect(items).toBeVisible();
});
