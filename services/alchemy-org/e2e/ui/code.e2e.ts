/**
 * The CODE activity: a session is a machine under a connected repo;
 * its threads and terminals share one tab strip. Sessions are server
 * facts from the moment they're named — never a tab that vanishes.
 */
import {
  REPO,
  pathOf,
  expect,
  main,
  openApp,
  routedTo,
  sidebar,
  tab,
  tabStrip,
  test,
} from "./harness.ts";

const SESSION = `${REPO}/s-e2e`;

const createSession = async (
  page: Parameters<typeof openApp>[0],
  name: string,
) => {
  await page
    .getByRole("button", { name: /^(new )?session$/ })
    .first()
    .click();
  const input = page.getByRole("textbox", { name: "Session name" });
  await input.fill(name);
  await input.press("Enter");
};

test("an empty directory invites the first session", async ({ page }) => {
  await openApp(page);
  await expect(main(page)).toContainText("No session selected");
  await expect(sidebar(page)).toMatchAriaSnapshot({
    name: "empty-sidebar.aria.yml",
  });
});

test("a new session is opened on the server and shown at once", async ({
  page,
  api,
}) => {
  await openApp(page);
  await createSession(page, "s-e2e");

  expect(api.opened).toEqual([`Engineer:${SESSION}`]);
  await expect(page).toHaveURL(routedTo(`Engineer:${SESSION}`));
  await expect(tab(page, "main")).toHaveAttribute("aria-selected", "true");
  await expect(sidebar(page)).toContainText("s-e2e");
});

test("sessions coexist — a second one never replaces the first", async ({
  page,
  api,
}) => {
  api.seedChat(`Engineer:${REPO}/s-first`);
  await openApp(page, pathOf(`Engineer:${REPO}/s-first`));
  await createSession(page, "s-second");

  await expect(sidebar(page)).toContainText("s-first");
  await expect(sidebar(page)).toContainText("s-second");
  expect(api.chats.map((row) => row.key).sort()).toEqual([
    `${REPO}/s-first`,
    `${REPO}/s-second`,
  ]);
  await sidebar(page).getByText("s-first", { exact: true }).click();
  await expect(page).toHaveURL(routedTo(`Engineer:${REPO}/s-first`));
});

test("threads and terminals share the strip; reload keeps them", async ({
  page,
  api,
}) => {
  api.seedChat(`Engineer:${SESSION}`);
  await openApp(page, pathOf(`Engineer:${SESSION}`));

  await main(page).getByRole("button", { name: "+" }).click();
  await page.getByRole("menuitem", { name: "New thread" }).click();
  await main(page).getByRole("button", { name: "+" }).click();
  await page.getByRole("menuitem", { name: "New terminal" }).click();
  await main(page).getByRole("button", { name: "+" }).click();
  await page.getByRole("menuitem", { name: "New terminal" }).click();

  await expect(tabStrip(page).getByRole("tab")).toHaveCount(4);
  await expect(main(page)).toContainText(
    "connected — the session's machine, a real shell",
  );
  expect(api.terminal.opened).toEqual(["main", "2"]);

  await page.reload({ waitUntil: "networkidle" });
  await expect(tabStrip(page).getByRole("tab")).toHaveCount(4);
  await expect(tab(page, />_\s*2/)).toHaveAttribute("aria-selected", "true");
  // a code session's machine is never "pulled" — that's a PR verb
  expect(api.checkouts).toEqual([]);
});

test("a machine that cannot start says why — and the words copy out", async ({
  page,
  api,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  api.seedChat(`Engineer:${SESSION}`);
  api.terminal.failOpen =
    "the session's tree could not be checked out: another worktree operation holds the lock";
  // the DO drops the socket too — the viewer reconnects and repaints
  // from scratch, the path that used to corrupt selections
  api.terminal.dropAfterError = true;
  await openApp(page, pathOf(`Engineer:${SESSION}`));
  await main(page).getByRole("button", { name: "+" }).click();
  await page.getByRole("menuitem", { name: "New terminal" }).click();
  // the overlay lifts so the error is readable; a reconnect follows
  await expect.poll(() => api.terminal.opened.length).toBeGreaterThan(1);

  // a double-click selects the word under it (the error's second row
  // — the first is the blank line before it) and ghostty copies on
  // select; then ⌘C copies the same selection again on request
  const canvas = main(page).locator(".ghostty-host canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.dblclick(box.x + 40, box.y + 16);
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/terminal/);
  await page.evaluate(() => navigator.clipboard.writeText(""));
  await page.keyboard.press("Meta+c");
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/terminal/);
});

test("close all to the right is positional across threads and terminals", async ({
  page,
  api,
}) => {
  api.seedChat(`Engineer:${SESSION}`);
  await openApp(page, pathOf(`Engineer:${SESSION}`));
  await main(page).getByRole("button", { name: "+" }).click();
  await page.getByRole("menuitem", { name: "New terminal" }).click();
  await main(page).getByRole("button", { name: "+" }).click();
  await page.getByRole("menuitem", { name: "New thread" }).click();
  await expect(tabStrip(page).getByRole("tab")).toHaveCount(3);

  await tab(page, "main").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Close all to the right" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close tabs" })
    .click();

  await expect(tabStrip(page).getByRole("tab")).toHaveCount(1);
  expect(api.deleted).toHaveLength(1);
  expect(api.deleted[0]).toMatch(/::t-/);
});

test("the tab strip's context menu", async ({ page, api }) => {
  api.seedChat(`Engineer:${SESSION}`);
  await openApp(page, pathOf(`Engineer:${SESSION}`));
  await tab(page, "main").click({ button: "right" });
  await expect(page.getByRole("menu")).toMatchAriaSnapshot({
    name: "thread-context-menu.aria.yml",
  });
});
