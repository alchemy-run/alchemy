/**
 * The GALLERY — one pixel snapshot per feature state, committed under
 * `__screenshots__/` so the UX can be SEEN in review, not just diffed
 * as an aria tree. Every shot runs against the same fake as the `ui`
 * project, under the fixed clock.
 */
import type { Page } from "@playwright/test";
import {
  acceptConfirm,
  expect,
  NOW,
  openApp,
  REPO,
  test,
  threadPath,
  type FakeApi,
} from "./harness.ts";

const shot = (page: Page, name: string, options?: { maxDiffPixels?: number }) =>
  expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false, ...options });

const seedWorld = (api: FakeApi) => {
  api.seedThread({
    id: "t-1",
    name: "w-reconcile",
    title: "Fix the reconcile bug",
    turn: "you",
    assigned: [
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
  await page.getByRole("button", { name: /notifications, 1 new/ }).click();
  await shot(page, "channel-03-bell");
});

test("channel: a selection and its menu, one item under the pointer", async ({
  page,
  api,
}) => {
  seedWorld(api);
  await openApp(page);
  const main = page.getByRole("main");
  // two rows selected (⌘-click each), the menu opened on one of them
  await main
    .getByText("triage that issue and start on a fix")
    .click({ modifiers: ["Meta"] });
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

test("channel: replying to several messages, the list collapsed", async ({
  page,
  api,
}) => {
  seedWorld(api);
  await openApp(page);
  const main = page.getByRole("main");
  const rowOf = (text: string) =>
    main.locator("[data-seq]", { hasText: text }).first();
  await rowOf("triage that issue").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reply" }).click();
  await rowOf("Placed it on w-reconcile").click({
    modifiers: ["ControlOrMeta"],
  });
  const bar = main.getByLabel("Replying to", { exact: true });
  await expect(bar).toContainText("Replying to 2 messages");
  await shot(page, "channel-05-reply-bar");
});

/** A thread asking the operator something only they can answer. */
const seedQuestion = (api: FakeApi) => {
  seedWorld(api);
  api.seedCard(
    { thread: "t-1", title: "Which base branch for #148?" },
    "The fix is ready to open. Against `main`, or the `release/2.x` branch the issue names? I will hold until you say.",
  );
};

test("notification: answering a card on the card", async ({ page, api }) => {
  seedQuestion(api);
  await openApp(page);
  const card = page.getByRole("main").locator("[data-card]").last();
  await card
    .getByRole("button", { name: "Answer: Which base branch for #148?" })
    .click();
  await card.getByLabel("Your answer").fill("main — release/2.x is frozen");
  await shot(page, "channel-07-card-answer");
});

test("notification: the card once answered", async ({ page, api }) => {
  seedQuestion(api);
  await openApp(page);
  const card = page.getByRole("main").locator("[data-card]").last();
  await card
    .getByRole("button", { name: "Answer: Which base branch for #148?" })
    .click();
  await card.getByLabel("Your answer").fill("main");
  await card.getByRole("button", { name: "Send" }).click();
  await expect(card.locator("[data-answered]")).toBeVisible();
  await shot(page, "channel-08-card-answered");
});

test("notification: answering from the bell, on another page", async ({
  page,
  api,
}) => {
  seedQuestion(api);
  await openApp(page, threadPath("t-2"));
  await page.getByRole("button", { name: /notifications, 2 new/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Answer: Which base branch for #148?" })
    .click();
  await dialog.getByLabel("Your answer").fill("main");
  await shot(page, "channel-09-bell-answer");
});

test("notification: the bell's jump lands on the card, flashed", async ({
  page,
  api,
}) => {
  seedQuestion(api);
  await openApp(page, threadPath("t-2"));
  await page.getByRole("button", { name: /notifications, 2 new/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", {
      name: "Jump to the card: Which base branch for #148?",
    })
    .click();
  await expect(
    page.getByRole("main").locator("[data-seq][data-flash]"),
  ).toBeVisible();
  await shot(page, "channel-10-card-jump");
});

test("channel: a thread being deleted", async ({ page, api }) => {
  seedWorld(api);
  const release = api.holdThreadDelete();
  await openApp(page, threadPath("t-2"));
  await page
    .getByRole("complementary", { name: "Thread state" })
    .getByRole("button", { name: "Delete thread" })
    .click();
  await acceptConfirm(page);
  await expect(page.getByRole("status")).toContainText("Deleting this thread");
  await shot(page, "channel-06-thread-deleting");
  release();
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

test("thread: a subagent's session", async ({ page, api }) => {
  seedWorld(api);
  api.seedBash("Engineer:engineer-1", {
    ask: "Implement the fix in pr-148's worktree",
    command: "pnpm test test/reconcile",
    stdout: "3 passed",
    reply: "Tests are green in the worktree; pushing the fix.",
  });
  await openApp(page, `${threadPath("t-1")}/agent/engineer-1`);
  await expect(page.getByRole("main")).toContainText("3 passed");
  await shot(page, "thread-02-agent-session");
});

test("thread: the bookkeeping the channel told the agent", async ({
  page,
  api,
}) => {
  seedWorld(api);
  // quiet deliveries — the agent hears them, it does not answer each:
  // the rows stack like the channel's own timeline
  for (const [number, title] of [
    [1521, "fix(cloudflare): forward container memoryMib"],
    [1523, "fix(cloudflare): validate cached container identity"],
    [1525, "fix(cloudflare): deduplicate container image publication"],
  ] as const) {
    api.seedInput(
      "Thread:t-1",
      `[assigned] ${REPO}#${number} — pull, open — ${title}`,
    );
  }
  api.seedInput(
    "Thread:t-1",
    `[channel] danieljvdm · ${new Date(NOW.getTime() - 3_600_000).toISOString()}\nopened pull request #1521 — fix(cloudflare): forward container memoryMib`,
  );
  api.seedInput(
    "Thread:t-1",
    `[channel] sam-goodwin · ${new Date(NOW.getTime() - 1_800_000).toISOString()}\nreview all three and merge what passes\nleave a note on anything you skip`,
  );
  api.seedInput("Thread:t-1", `[unassigned] ${REPO}#1525`);
  // then the brief wakes it, and it answers once
  api.seedTurn(
    "Thread:t-1",
    "Review the three pull requests and merge what passes.",
    "Reviewing all three now; I will merge what is green.",
  );
  await openApp(page, threadPath("t-1"));
  await expect(page.getByRole("main")).toContainText("Reviewing all three");
  await shot(page, "thread-03-bookkeeping");
});

test("thread: the read_state card, opened", async ({ page, api }) => {
  seedWorld(api);
  api.seedTool("Thread:t-1", {
    ask: "where do things stand?",
    name: "read_state",
    input: {},
    output: {
      state: {
        id: "t-1",
        name: "w-reconcile",
        title: "Fix the reconcile bug",
        status: "open",
        turn: "agents",
        assigned: [
          {
            ref: `${REPO}#148`,
            kind: "pull",
            state: "open",
            title: "Add sumToN helper",
            worktree: "/workspace/trees/pr-148",
          },
          { ref: `${REPO}#12`, kind: "issue", state: "open", title: "Bug" },
        ],
        agents: [
          {
            key: "engineer-1",
            kind: "engineer",
            brief: "Implement the fix",
            state: "running",
          },
        ],
      },
    },
    reply: "One engineer is still working.",
  });
  await openApp(page, threadPath("t-1"));
  const card = page.getByRole("main").locator("[data-tool='read_state']");
  await card.getByRole("button").first().click();
  await expect(card).toContainText("Assigned · 2");
  await shot(page, "thread-04-read-state");
});

test("thread: an agent's menu in the state pane", async ({ page, api }) => {
  seedWorld(api);
  await openApp(page, threadPath("t-1"));
  await page
    .getByRole("complementary", { name: "Thread state" })
    .locator("[data-agent='engineer-1']")
    .click({ button: "right" });
  const item = page.getByRole("menuitem", { name: "Stop" });
  await item.hover();
  await expect(item).toHaveAttribute("data-highlighted", "");
  await shot(page, "thread-05-agent-menu");
});

test("thread: the switches en masse, and a card reading the thread state", async ({
  page,
  api,
}) => {
  seedWorld(api);
  api.seedThread({
    id: "t-1",
    name: "w-reconcile",
    title: "Fix the reconcile bug",
    turn: "you",
    agents: [
      {
        key: "engineer-1",
        kind: "engineer",
        brief: "Implement the fix in pr-148's worktree",
        state: "running",
        startedAt: NOW.getTime() - 120_000,
      },
      {
        key: "engineer-2",
        kind: "engineer",
        brief: "Add a regression test for the off-by-one",
        state: "stopped",
        startedAt: NOW.getTime() - 100_000,
        settledAt: NOW.getTime() - 40_000,
      },
    ],
  });
  // the spawn call is still open on the wire, but the thread state says the
  // operator stopped that engineer — the card reads the thread state
  api.seedOpenRound("Thread:t-1", {
    ask: "cover the fix with a regression test",
    name: "spawn",
    input: { brief: "Add a regression test for the off-by-one" },
  });
  await openApp(page, threadPath("t-1"));
  await expect(page.getByRole("main").locator("[data-settled]")).toHaveText(
    "stopped",
  );
  await expect(
    page
      .getByRole("complementary", { name: "Thread state" })
      .getByRole("button", {
        name: "Stop all",
      }),
  ).toBeVisible();
  await shot(page, "thread-06-agent-switches");
});

test("thread: a run of worktrees folded, and another opened", async ({
  page,
  api,
}) => {
  seedWorld(api);
  const worktree = (n: number) => ({
    name: "worktree",
    input: { ref: `${REPO}#${n}` },
    output: { path: `/workspace/trees/pr-${n}`, branch: `pr-${n}` },
  });
  // five in a row: one line
  api.seedTools("Thread:t-1", {
    ask: "make a worktree for each of the five pulls",
    calls: [1521, 1522, 1523, 1524, 1525].map(worktree),
    reply: "Five worktrees ready.",
  });
  // three more, still running two of them
  api.seedTools("Thread:t-1", {
    ask: "and the three follow-ups",
    calls: [
      worktree(1526),
      { ...worktree(1527), open: true },
      { ...worktree(1528), open: true },
    ],
    reply: "",
  });
  await openApp(page, threadPath("t-1"));
  const runs = page.getByRole("main").locator("[data-tool-run='worktree']");
  await expect(runs).toHaveCount(2);
  await expect(runs.nth(1)).toContainText("2 running…");
  // the first one opened, to show the fold's inside
  await runs.nth(0).getByRole("button", { expanded: false }).click();
  await expect(
    page.getByRole("main").locator("[data-tool='worktree']"),
  ).toHaveCount(5);
  await shot(page, "thread-07-tool-run");
});

test("thread: the model selector open in the composer", async ({
  page,
  api,
}) => {
  seedWorld(api);
  api.updateThread("t-1", { model: "claude-opus-5" });
  api.seedTool("Thread:t-1", {
    ask: "get a worktree for the PR",
    name: "worktree",
    input: { ref: `${REPO}#148` },
    output: { path: "/workspace/trees/pr-148", branch: "pr-148" },
    reply: "Worktree ready — the engineer works there.",
  });
  await openApp(page, threadPath("t-1"));
  await expect(page.getByRole("main")).toContainText("Worktree ready");
  // the pick rides the chat input of the agent being talked to
  const select = page
    .getByRole("main")
    .getByRole("combobox", { name: "The agent's model" });
  await expect(select).toContainText("Claude Opus 5");
  await select.click();
  const option = page.getByRole("option", { name: /GPT-6 Astra/ });
  await option.hover();
  await expect(option).toHaveAttribute("data-highlighted", "");
  await shot(page, "thread-08-model-selector");
});

test("thread: the manager working on a reply", async ({ page, api }) => {
  seedWorld(api);
  api.seedTurn(
    "Thread:t-1",
    "how is the fix going?",
    "The engineer is mid-way; tests pass locally.",
  );
  await openApp(page, threadPath("t-1"));
  // the operator asks; nothing has streamed back yet — the working
  // row holds the tail until the first sampling lands
  const composer = page.getByPlaceholder("Talk to the manager…");
  await composer.fill("run the full suite and report");
  await composer.press("Enter");
  await expect(page.getByRole("main").locator("[data-working]")).toBeVisible();
  await shot(page, "thread-09-working");
});

test("thread: the delete confirm — the app asks in page", async ({
  page,
  api,
}) => {
  seedWorld(api);
  await openApp(page, threadPath("t-1"));
  await page
    .getByRole("complementary", { name: "Thread state" })
    .getByRole("button", { name: "Delete thread" })
    .click();
  await expect(page.locator("[data-confirm]")).toBeVisible();
  await shot(page, "thread-10-confirm-delete");
});

test("thread: closed — the pane offers Reopen", async ({ page, api }) => {
  seedWorld(api);
  api.seedThread({
    id: "t-1",
    name: "w-reconcile",
    title: "Fix the reconcile bug",
    status: "closed",
    turn: "idle",
  });
  await openApp(page, threadPath("t-1"));
  await expect(
    page.getByRole("button", { name: "Reopen thread" }),
  ).toBeVisible();
  await shot(page, "thread-11-closed");
});

test("thread: hovering the selected agent row adds the border", async ({
  page,
  api,
}) => {
  seedWorld(api);
  await openApp(page, threadPath("t-1"));
  const pane = page.getByRole("complementary", { name: "Thread state" });
  await pane.getByRole("button", { name: "open agent engineer-1" }).click();
  // selected + hovered — the fourth state: full accent AND a border
  await pane.getByRole("button", { name: "open agent engineer-1" }).hover();
  await shot(page, "thread-12-agent-hover");
});

test("review: the diff", async ({ page, api }) => {
  seedWorld(api);
  await openApp(page, `${threadPath("t-1")}/alchemy-run/test-alchemy/pull/148`);
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
  // ghostty paints its own canvas (cursor, glyph atlas) — the one shot
  // that is not pixel-reproducible, a few hundred pixels run to run
  await shot(page, "thread-02-terminal", { maxDiffPixels: 2_000 });
});
