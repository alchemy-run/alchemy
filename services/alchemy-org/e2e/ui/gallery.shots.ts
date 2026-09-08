/**
 * The GALLERY — one pixel snapshot per feature state, committed under
 * `__screenshots__/` so the UX can be SEEN in review, not just diffed
 * as an aria tree. Every shot runs against the same fake as the `ui`
 * project, under the fixed clock.
 */
import type { Page } from "@playwright/test";
import {
  expect,
  NOW,
  openApp,
  REPO,
  test,
  threadPath,
  type FakeApi,
} from "./harness.ts";

const shot = (page: Page, name: string) =>
  expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false });

const seedWorld = (api: FakeApi) => {
  api.seedThread({
    id: "t-1",
    name: "w-reconcile",
    title: "Fix the reconcile bug",
    turn: "you",
    entities: [
      {
        ref: `${REPO}#12`,
        kind: "issue",
        state: "open",
        title: "Bug in reconcile",
      },
      {
        ref: `${REPO}#148`,
        kind: "pull",
        state: "open",
        title: "Add sumToN helper",
        worktree: "/workspace/trees/pr-148",
      },
    ],
    agents: [
      {
        key: "engineer-1",
        kind: "engineer",
        brief: "Implement the fix in pr-148's worktree",
        state: "running",
        startedAt: NOW.getTime() - 120_000,
      },
    ],
  });
  api.seedThread({
    id: "t-2",
    name: "w-charts",
    title: "Terminal charts",
    turn: "agents",
  });
  api.seedEvent(
    `opened issue [${REPO}#12](https://github.com/${REPO}/issues/12) — Bug in reconcile`,
    { author: "octocat", event: "IssueOpened", ref: `${REPO}#12` },
  );
  api.seedUser("triage that issue and start on a fix");
  api.seedAgent("Placed it on w-reconcile; the engineer is on it.");
  api.seedCard(
    { thread: "t-1", title: "Pushed the fix to #148" },
    "The loop bound is corrected; CI is running on the pull request.",
  );
};

test("channel: the stream, a card, the directory", async ({ page, api }) => {
  seedWorld(api);
  await openApp(page);
  await shot(page, "channel-01-stream");
});

test("channel: light mode", async ({ page, api }) => {
  seedWorld(api);
  await openApp(page);
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => {
    localStorage.setItem("theme", "light");
    document.documentElement.classList.remove("dark");
  });
  await shot(page, "channel-02-stream-light");
});

test("channel: the bell's list", async ({ page, api }) => {
  seedWorld(api);
  await openApp(page);
  await page
    .getByRole("button", { name: /notifications, 1 new/ })
    .click();
  await shot(page, "channel-03-bell");
});

test("channel: a selection and its menu, one item under the pointer", async ({
  page,
  api,
}) => {
  seedWorld(api);
  await openApp(page);
  const main = page.getByRole("main");
  // two rows selected (click, ⌘-click), the menu opened on one of them
  await main.getByText("triage that issue and start on a fix").click();
  await main
    .getByText("Placed it on w-reconcile; the engineer is on it.")
    .click({ modifiers: ["Meta"] });
  await main
    .locator("[data-seq]", { hasText: "triage that issue" })
    .first()
    .click({ button: "right" });
  const item = page.getByRole("menuitem", { name: "Delete 2 messages" });
  await item.hover();
  // the highlighted item reads as such — the surface lifts off the menu
  await expect(item).toHaveAttribute("data-highlighted", "");
  await shot(page, "channel-04-selection-menu");
});

test("thread: the conversation and the state pane", async ({ page, api }) => {
  seedWorld(api);
  api.seedTool("Thread:t-1", {
    ask: "get a worktree for the PR",
    name: "worktree",
    input: { ref: `${REPO}#148` },
    output: { path: "/workspace/trees/pr-148", branch: "pr-148" },
    reply: "Worktree ready — the engineer works there.",
  });
  await openApp(page, threadPath("t-1"));
  await expect(page.getByRole("main")).toContainText("Worktree ready");
  await shot(page, "thread-01-conversation");
});

test("review: the diff beside the chat", async ({ page, api }) => {
  seedWorld(api);
  api.seedTurn(
    "Thread:t-1",
    "review the helper",
    "The loop bound is off by one — see the selection.",
  );
  await openApp(
    page,
    `${threadPath("t-1")}/alchemy-run/test-alchemy/pull/148`,
  );
  await expect(page.getByRole("main")).toContainText("flow-test/sum.ts");
  await shot(page, "review-01-diff");
});

test("terminal: the thread's machine", async ({ page, api }) => {
  seedWorld(api);
  await openApp(page, threadPath("t-1"));
  await page.getByRole("button", { name: "new terminal" }).click();
  // the prompt's bytes land in ghostty's canvas, not the DOM — the
  // status line is the socket's proof of life
  await expect(page.getByRole("main")).toContainText("connected");
  await expect.poll(() => api.terminal.opened.length).toBe(1);
  await shot(page, "thread-02-terminal");
});
