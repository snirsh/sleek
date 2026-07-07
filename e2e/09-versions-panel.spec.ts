/**
 * Spec 9: Versions banner/panel (adaptive).
 * Behaviour depends on whether the store holds >1 scaffold version for the e2e PR:
 *   - >1 version: #verbanner becomes visible; clicking "What changed?" opens
 *     #verswrap; Esc closes it.
 *   - only 1 version: #verbanner stays hidden.
 *
 * We probe /api/versions to decide which branch to take.
 */

import { test, expect } from "@playwright/test";
import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("versions panel: adaptive — banner visible if multiple versions, absent if single", async ({
  page,
}) => {
  // Probe the versions API to know which branch we're in.
  const versRes = await fetch(`${baseUrl()}/api/versions`);
  const versData = versRes.ok
    ? (await versRes.json() as { versions?: unknown[] })
    : { versions: [] };
  const versions = Array.isArray(versData.versions) ? versData.versions : [];
  const hasMultiple = versions.length >= 2;

  await page.goto(baseUrl());

  const verbanner = page.locator("#verbanner");

  if (hasMultiple) {
    // Banner should become visible once the client probes /api/versions.
    await expect(verbanner).toBeVisible({ timeout: 10000 });

    // Click "What changed?" to open the versions panel.
    const openBtn = page.locator("#verbanner-open");
    await openBtn.click();

    const verswrap = page.locator("#verswrap");
    await expect(verswrap).toBeVisible({ timeout: 5000 });

    // Press Esc — versions panel should close (per dismiss chain).
    await page.keyboard.press("Escape");
    await expect(verswrap).toBeHidden({ timeout: 3000 });
  } else {
    // Only one scaffold version: banner must stay hidden even after initial load.
    // Allow time for the client to probe /api/versions and decide not to show it.
    await page.waitForTimeout(3000);
    await expect(verbanner).toBeHidden();
  }
});
