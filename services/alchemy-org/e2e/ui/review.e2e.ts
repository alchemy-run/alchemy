/**
 * The REVIEW — the diff alone: paged files, large-file gating, the
 * refresh. No conversation rides here (a later concern).
 */
import { expect, main, openApp, REPO, test, threadPath } from "./harness.ts";

const REVIEW_PATH = `${threadPath("t-1")}/alchemy-run/test-alchemy/pull/147`;

const seed = (api: import("./harness.ts").FakeApi) => {
  api.seedThread({
    id: "t-1",
    name: "w-viz",
    title: "Terminal charts",
    assigned: [
      {
        ref: `${REPO}#147`,
        kind: "pull",
        state: "open",
        title: "Add array helpers: chunk and unique",
      },
    ],
  });
};

test("the header carries the pull's state, branches, and size", async ({
  page,
  api,
}) => {
  seed(api);
  await openApp(page, REVIEW_PATH);

  await expect(main(page)).toContainText("Add array helpers: chunk and unique");
  await expect(main(page)).toContainText("Open");
  await expect(main(page)).toContainText("→ main");

  // the way out is the tab strip: the manager's tab is always there
  await main(page).getByRole("tab", { name: /manager/ }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
});

test("files page in one by one until the last page", async ({ page, api }) => {
  seed(api);
  await openApp(page, REVIEW_PATH);

  // pr-147 has several files; the fake serves one per page
  await expect
    .poll(() => api.filePages.filter((entry) => entry.number === 147).length)
    .toBeGreaterThan(1);
  await expect(main(page)).toContainText("src/arrays.ts");
});

test("a huge file waits behind a click", async ({ page, api }) => {
  seed(api);
  api.large.add("src/arrays.ts");
  await openApp(page, REVIEW_PATH);

  const gate = main(page).getByRole("button", {
    name: /Large diff .* click to render/,
  });
  await expect(gate).toBeVisible();
  await gate.click();
  await expect(gate).toBeHidden();
});

test("a file with no patch says so instead of a broken card", async ({
  page,
  api,
}) => {
  seed(api);
  api.unrenderable.add("src/arrays.ts");
  await openApp(page, REVIEW_PATH);

  await expect(main(page)).toContainText(
    "No diff to render (binary or too large).",
  );
});

test("a file card collapses to its header", async ({ page, api }) => {
  seed(api);
  await openApp(page, REVIEW_PATH);

  const header = main(page)
    .getByRole("button", { name: /src\/arrays\.ts/ })
    .first();
  await header.click();
  // collapsed: the header stays, the hunks go
  await expect(header).toBeVisible();
});

test("switching tabs keeps the review mounted — no refetch", async ({
  page,
  api,
}) => {
  seed(api);
  await openApp(page, REVIEW_PATH);
  await expect(main(page)).toContainText("src/arrays.ts");
  const loads = api.pullLoads.length;
  const pages = api.filePages.length;

  // away to the manager and back — the diff must still be there
  // without a single new fetch (the view stayed mounted behind its tab)
  await main(page).getByRole("tab", { name: /manager/ }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
  await main(page).getByRole("tab", { name: "#147" }).click();
  await expect(main(page)).toContainText("src/arrays.ts");
  expect(api.pullLoads.length).toBe(loads);
  expect(api.filePages.length).toBe(pages);
});

test("a diagonal wheel gesture over the code scrolls the pane", async ({
  page,
  api,
}) => {
  seed(api);
  await openApp(page, REVIEW_PATH);
  const card = main(page).locator("[data-review-file]").first();
  await expect(card).toBeVisible();

  // vertical-dominant with a horizontal component — the gesture must
  // move the pane, not latch onto the code area's horizontal scroller
  await card.hover();
  await page.mouse.wheel(40, 300);
  const pane = main(page).locator("[data-review-scroll]");
  await expect
    .poll(() => pane.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});

test("refresh re-fetches the diff", async ({ page, api }) => {
  seed(api);
  await openApp(page, REVIEW_PATH);
  await expect.poll(() => api.pullLoads.length).toBeGreaterThan(0);
  const before = api.filePages.length;

  await main(page).getByTitle("Refresh the diff from GitHub").click();
  await expect.poll(() => api.filePages.length).toBeGreaterThan(before);
});

test("the review is the diff alone — no chat rides beside it", async ({
  page,
  api,
}) => {
  seed(api);
  api.seedTurn(
    "Thread:t-1",
    "review the error handling",
    "Looking at the renderer's bounds checks now.",
  );
  await openApp(page, REVIEW_PATH);
  await expect(main(page)).toContainText("src/arrays.ts");

  // the thread's conversation stays on the thread's chat tab — the
  // review page shows no transcript and no review composer (the
  // manager's chat is mounted but hidden behind its own tab)
  await expect(
    page.getByRole("complementary", { name: "Review chat" }),
  ).toHaveCount(0);
  await expect(
    main(page).getByText("review the error handling"),
  ).toBeHidden();
  await expect(page.getByPlaceholder("Chat with the review…")).toHaveCount(0);
});
