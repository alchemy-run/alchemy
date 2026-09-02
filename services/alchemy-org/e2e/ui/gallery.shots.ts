/**
 * The GALLERY — one screenshot per feature state, in the order a tour
 * would show them. Committed under `__screenshots__/` so a reviewer
 * SEES the UX; enforced with `toHaveScreenshot` so it can't drift
 * unnoticed. Re-bless after a deliberate change: `pnpm test:e2e:update`.
 */
import {
  REPO,
  encodeHash,
  expect,
  main,
  openApp,
  tab,
  test,
} from "./harness.ts";

const PR = `${REPO}#148`;

const shell = (page: Parameters<typeof openApp>[0]) =>
  expect(main(page)).toContainText("connected — the session's machine");

test.describe("code", () => {
  test("01 empty directory", async ({ page }) => {
    await openApp(page);
    await expect(main(page)).toContainText("no session selected");
    await expect(page).toHaveScreenshot("code-01-empty.png");
  });

  test("02 new session dialog", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "+ new session" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // the generated name has a random tail — pin it for the picture
    await page.getByRole("textbox", { name: "Session name" }).fill("s-gallery");
    await expect(page).toHaveScreenshot("code-02-new-session.png");
  });

  test("03 a session: threads and terminals on one machine", async ({
    page,
    api,
  }) => {
    api.seedChat(`Engineer:${REPO}/s-alpha`, "running");
    api.seedChat(`Engineer:${REPO}/s-alpha::t-review-notes`);
    api.seedChat(`Engineer:${REPO}/s-beta`, "settled");
    await openApp(page, encodeHash(`Engineer:${REPO}/s-alpha`));
    await main(page).getByRole("button", { name: "+" }).click();
    await page.getByRole("menuitem", { name: "New terminal" }).click();
    await shell(page);
    await page.keyboard.type("git status --short");
    await expect.poll(() => api.terminal.typed.main).toBe("git status --short");
    await expect(page).toHaveScreenshot("code-03-session-terminal.png");
  });

  test("04 tab context menu", async ({ page, api }) => {
    api.seedChat(`Engineer:${REPO}/s-alpha`);
    api.seedChat(`Engineer:${REPO}/s-alpha::t-review-notes`);
    await openApp(page, encodeHash(`Engineer:${REPO}/s-alpha`));
    await tab(page, "main").click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page).toHaveScreenshot("code-04-tab-menu.png");
  });

  test("05 delete thread confirmation", async ({ page, api }) => {
    api.seedChat(`Engineer:${REPO}/s-alpha`);
    api.seedChat(`Engineer:${REPO}/s-alpha::t-review-notes`);
    await openApp(page, encodeHash(`Engineer:${REPO}/s-alpha::t-review-notes`));
    await tab(page, /review-notes/).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete thread" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page).toHaveScreenshot("code-05-delete-thread.png");
  });
});

test.describe("review", () => {
  test("01 the board", async ({ page, api }) => {
    api.seedChat(`Engineer:${PR}`);
    await openApp(page);
    await page.getByRole("button", { name: /^Review/ }).click();
    await expect(main(page)).toContainText("Select a pull request.");
    await expect(page).toHaveScreenshot("review-01-board.png");
  });

  test("02 pull request overview", async ({ page }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await expect(main(page)).toContainText("approved these changes");
    await expect(page).toHaveScreenshot("review-02-overview.png");
  });

  test("03 inline review comment expanded", async ({ page }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page)
      .getByRole("button", { name: /flow-test\/sum\.ts:4/ })
      .click();
    await expect(main(page)).toContainText("export function sumToN");
    await expect(page).toHaveScreenshot("review-03-inline-diff.png");
  });

  test("04 machine pulled onto the PR head", async ({ page }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "pull" }).click();
    await expect(main(page)).toContainText("on flow-test-deploy @ 7d7584e");
    await expect(page).toHaveScreenshot("review-04-machine-ready.png");
  });

  test("05 the bot's review alongside an engineer thread", async ({
    page,
    api,
  }) => {
    api.seedChat(`ReviewBot:${PR}`, "running");
    api.board.prs[0]!.session = { id: `ReviewBot:${PR}`, status: "running" };
    api.seedChat(`Engineer:${PR}`);
    await openApp(page, encodeHash(`pr:${PR}`));
    await expect(tab(page, "Review")).toBeVisible();
    await expect(tab(page, "main")).toBeVisible();
    await expect(page).toHaveScreenshot("review-05-review-and-thread-tabs.png");
  });

  test("06 a terminal on the PR's machine", async ({ page, api }) => {
    api.seedChat(`Engineer:${PR}`);
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "terminal" }).click();
    await shell(page);
    await page.keyboard.type("git log --oneline -1");
    await expect
      .poll(() => api.terminal.typed.main)
      .toBe("git log --oneline -1");
    await expect(page).toHaveScreenshot("review-06-terminal.png");
  });

  test("07 pull request context menu", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: /^Review/ }).click();
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /Add sumToN helper/ })
      .click({ button: "right" });
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page).toHaveScreenshot("review-07-pr-menu.png");
  });
});
