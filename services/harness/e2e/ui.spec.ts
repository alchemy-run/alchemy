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
  await expect(page.getByTestId("thinking")).toHaveCount(0);
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
  await expect(page.getByTestId("thinking")).toHaveCount(0);

  await send(page, "What number did I ask you to remember? Reply with only the number.");
  await expect(page.locator(".is-assistant").filter({ hasText: "7341" })).toBeVisible();
});

test("a turn's work folds behind 'Worked for' and expands into tool rows", async ({ page }) => {
  await send(
    page,
    "Run `git log --oneline -1` and read package.json, then reply with only the package name.",
  );
  // While the turn runs, its timer counts up.
  await expect(page.getByTestId("turn-fold")).toContainText("Working for");
  // Settled: the work folds away and the answer reads first.
  await expect(page.getByTestId("turn-fold")).toContainText(/Worked for \d/);
  await expect(page.getByTestId("tool-command")).toHaveCount(0);

  await page.getByTestId("turn-fold").click();
  // Consecutive tool calls group under a summary ("Ran 1 command and read 1 file").
  const group = page.getByTestId("tool-group").first();
  if (await group.isVisible()) {
    await expect(group).toContainText(/Ran \d+ command/);
    await group.getByRole("button").first().click();
  }
  const command = page.getByTestId("tool-command").first();
  await expect(command).toContainText("git log");
  await expect(page.getByTestId("tool-read").first()).toContainText("Read package.json");
  // A command expands into its output.
  await command.getByRole("button").first().click();
  await expect(command).toContainText("$ git log --oneline -1");
});

test("thinking streams as 'Thinking…', then settles as an expandable thought", async ({ page }) => {
  await send(page, "Think it through step by step: what is 17*23 - 4? Reply with only the number.");
  await expect(page.getByTestId("thinking").first()).toBeVisible();
  await expect(page.getByTestId("turn-fold")).toContainText(/Worked for \d/);
  await expect(page.locator(".is-assistant").filter({ hasText: "387" })).toBeVisible();

  await page.getByTestId("turn-fold").click();
  const thought = page.getByTestId("thought").first();
  await expect(thought).toContainText(/Thought for \d/);
  await thought.getByRole("button").first().click();
  await expect(thought).toContainText("17");
});

test("another browser sees the same sessions", async ({ page, browser }) => {
  await send(page, "Reply with exactly the word: shared");
  await expect(page.locator(".is-assistant").filter({ hasText: /shared/i })).toBeVisible();
  const id = decodeURIComponent(new URL(page.url()).hash.slice(1));
  expect(id).not.toBe("");

  // A fresh context: no storage, like another laptop.
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const elsewhere = await other.newPage();
  await elsewhere.goto("/");
  await expect(elsewhere.locator("aside").getByText(id, { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  // Its status and cost come from the server, though this browser never opened it.
  const row = elsewhere.locator("aside nav button").filter({ hasText: id });
  await expect(row).toContainText(/idle/i, { timeout: 30_000 });
  await expect(row).toContainText("$");
  // And a link opens the session with its transcript.
  await elsewhere.goto(`/#${encodeURIComponent(id)}`);
  await expect(elsewhere.locator(".is-user").filter({ hasText: "shared" })).toBeVisible({
    timeout: 60_000,
  });
  await other.close();
});

test("a session's machine shows its stats and can be paused and resumed", async ({ page }) => {
  await send(page, "Reply with exactly the word: machine");
  await expect(page.locator(".is-assistant").filter({ hasText: /machine/i })).toBeVisible();

  const machine = page.getByTestId("machine");
  await expect(machine.getByTestId("machine-state")).toHaveText("Running", { timeout: 30_000 });
  await expect(machine).toContainText("Cloudflare Container");
  await expect(machine).toContainText("standard-4");
  // Live usage from inside the machine: memory used of total.
  await expect(machine).toContainText(/\d+(\.\d)? [MG]B \/ \d+(\.\d)? GB/, { timeout: 30_000 });

  await machine.getByTestId("machine-toggle").click();
  await expect(machine.getByTestId("machine-state")).toHaveText("Suspended", { timeout: 180_000 });
  await expect(
    page.locator("aside nav [data-testid=machine-dot][data-state=suspended]").first(),
  ).toBeVisible({ timeout: 30_000 });

  await machine.getByTestId("machine-toggle").click();
  await expect(machine.getByTestId("machine-state")).toHaveText("Running", { timeout: 180_000 });
});
