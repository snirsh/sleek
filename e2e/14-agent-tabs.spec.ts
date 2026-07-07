import { test, expect } from "@playwright/test";

import { baseUrl, e2eConfigured, E2E_SKIP_MESSAGE } from "./fixtures.ts";

test.skip(!e2eConfigured, E2E_SKIP_MESSAGE);

test("right pane tabs switch between context, conversation, and draft", async ({ page }) => {
  await page.goto(baseUrl());

  const context = page.locator("#side-context");
  const conversation = page.locator("#side-conversation");
  const draft = page.locator("#side-draft");

  await expect(context).toBeVisible();
  await expect(conversation).toBeHidden();
  await expect(draft).toBeHidden();

  await page.getByRole("tab", { name: "Conversation" }).click();
  await expect(context).toBeHidden();
  await expect(conversation).toBeVisible();
  await expect(draft).toBeHidden();

  await page.getByRole("tab", { name: "Draft Comment" }).click();
  await expect(context).toBeHidden();
  await expect(conversation).toBeHidden();
  await expect(draft).toBeVisible();

  await page.getByRole("tab", { name: "Model Context" }).click();
  await expect(context).toBeVisible();
});

test("agent-created comments render as local drafts after refresh", async ({ page }) => {
  await page.goto(baseUrl());
  const health = await (await fetch(`${baseUrl()}/api/health`)).json() as { agent?: boolean };
  if (!health.agent) test.skip(true, "agent API not available");

  const create = await fetch(`${baseUrl()}/api/agent/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      anchor: { file: "src/util.ts", side: "RIGHT", startLine: 12, endLine: 12 },
      body: "Agent-created local draft from e2e",
    }),
  });
  expect(create.status).toBe(201);

  await page.getByRole("tab", { name: "Conversation" }).click();
  await page.locator("#conv-refresh").click();
  await page.getByRole("tab", { name: "Draft Comment" }).click();
  await expect(page.locator("#draft-list")).toContainText("Agent-created local draft from e2e");
  await expect(page.locator("#draft-list")).toContainText("Local draft");
});
