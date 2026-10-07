import { expect, type Page, test } from "@playwright/test";

const composer = (page: Page) => page.getByPlaceholder("Ask the agent to do something…");

const send = async (page: Page, prompt: string) => {
  await composer(page).fill(prompt);
  await composer(page).press("Enter");
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New session" }).first().click();
});

test("a message shows immediately and the agent replies", async ({ page }) => {
  await send(page, "Reply with exactly the word: pong");

  // Shown straight away, even while the session's workspace is prepared.
  await expect(page.locator(".is-user").filter({ hasText: "pong" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.locator(".is-assistant").filter({ hasText: /pong/i })).toBeVisible();
  // The turn ends: the composer is ready for the next prompt.
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText("Working…")).toHaveCount(0);
});

test("a session's transcript survives a reload", async ({ page }) => {
  await send(page, "Reply with exactly the word: persisted");
  await expect(page.locator(".is-assistant").filter({ hasText: /persisted/i })).toBeVisible();

  await page.reload();
  // The transcript replays from the session's event log.
  await expect(page.locator(".is-user").filter({ hasText: "persisted" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator(".is-assistant").filter({ hasText: /persisted/i })).toBeVisible({
    timeout: 60_000,
  });
});

test("a follow-up continues the same conversation", async ({ page }) => {
  await send(page, "Remember the number 7341. Reply with exactly: ok");
  await expect(page.locator(".is-assistant").filter({ hasText: /ok/i })).toBeVisible();
  await expect(page.getByText("Working…")).toHaveCount(0);

  await send(page, "What number did I ask you to remember? Reply with only the number.");
  await expect(page.locator(".is-assistant").filter({ hasText: "7341" })).toBeVisible();
});
