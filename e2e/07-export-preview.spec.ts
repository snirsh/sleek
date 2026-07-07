/**
 * Spec 7: Export preview (dry-run only).
 * Verifies: after submitting a review (via the submit modal), the
 * "Post to GitHub" button in the pending bar opens the export modal;
 * the #export-preview container is populated.
 *
 * SAFETY: We NEVER click #export-go (the real "Post to GitHub" confirm).
 * We only open the modal and read the preview content, then cancel.
 *
 * Requires: health.threads && health.githubExport
 */

import { test, expect } from "@playwright/test";
import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("export preview: dry-run preview renders in export modal", async ({ page }) => {
  const health = await (await fetch(`${baseUrl()}/api/health`)).json() as {
    threads?: boolean;
    githubExport?: boolean;
  };
  if (!health.threads || !health.githubExport) {
    test.skip();
    return;
  }

  await page.goto(baseUrl());

  // Step 1: Submit a review via the keyboard shortcut r→a (approve).
  // The r-chord arms the review shortcut; 'a' triggers approve verdict.
  // The chord is only wired once the client finishes its threads init
  // (threadsApi), which races page load — so poll the chord instead of
  // firing it once. Re-pressing "r" while armed just re-arms, so this is safe.
  const submitWrap = page.locator("#submitwrap");
  await expect(async () => {
    await page.keyboard.press("r");
    await page.keyboard.press("a");
    await expect(submitWrap).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // Approve verdict should be pre-selected (we pressed r+a).
  const approveRadio = page.locator("input[name='verdict'][value='approve']");
  // It may or may not be checked; just make sure the modal appeared.
  // Click "Submit review".
  const submitGo = page.locator("#submit-go");
  await expect(submitGo).toBeVisible();
  await submitGo.click();

  // Pending bar should appear, then "Post to GitHub" button becomes visible.
  const pendbar = page.locator("#pendbar");
  await expect(pendbar).toBeVisible({ timeout: 8000 });

  const exportBtn = page.locator("#pend-export");
  await expect(exportBtn).toBeVisible({ timeout: 5000 });

  // Click "Post to GitHub" to open the export modal (dry-run preview).
  await exportBtn.click();

  const exportWrap = page.locator("#exportwrap");
  await expect(exportWrap).toBeVisible({ timeout: 8000 });

  // The #export-preview must be populated (non-empty).
  const exportPreview = page.locator("#export-preview");
  await expect(exportPreview).toBeVisible();
  // Preview content renders — assert it's not empty.
  await expect(exportPreview).not.toBeEmpty({ timeout: 8000 });

  // NEVER click #export-go. Cancel only.
  const cancelBtn = page.locator("#export-cancel");
  await cancelBtn.click();
  await expect(exportWrap).toBeHidden({ timeout: 3000 });
});
