/**
 * The REVIEW — the diff column (paged files, large-file gating, the
 * refresh) beside the thread's chat.
 */
import { expect, main, openApp, REPO, test, threadPath } from "./harness.ts";

const REVIEW_PATH = `${threadPath("t-1")}/alchemy-run/test-alchemy/pull/147`;

const seed = (api: import("./harness.ts").FakeApi) => {
  api.seedThread({
    id: "t-1",
    name: "w-viz",
    title: "Terminal charts",
    entities: [
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

test("refresh re-fetches the diff", async ({ page, api }) => {
  seed(api);
  await openApp(page, REVIEW_PATH);
  await expect.poll(() => api.pullLoads.length).toBeGreaterThan(0);
  const before = api.filePages.length;

  await main(page).getByTitle("Refresh the diff from GitHub").click();
  await expect.poll(() => api.filePages.length).toBeGreaterThan(before);
});

test("the thread's chat rides beside the diff", async ({ page, api }) => {
  seed(api);
  api.seedTurn(
    "Thread:t-1",
    "review the error handling",
    "Looking at the renderer's bounds checks now.",
  );
  await openApp(page, REVIEW_PATH);

  const rail = page.getByRole("complementary", { name: "Review chat" });
  await expect(rail).toContainText("review the error handling");
  await expect(rail).toContainText(
    "Looking at the renderer's bounds checks now.",
  );
  await expect(rail.getByPlaceholder("Chat with the review…")).toBeVisible();
});
