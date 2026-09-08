/**
 * A THREAD's page — the conversation (the agent session's transcript
 * over the run socket), the state pane (entities, agents), the tabs
 * (chat, per-pull review, terminals on the thread's machine).
 */
import {
  expect,
  main,
  NOW,
  openApp,
  REPO,
  test,
  threadNav,
  threadPath,
} from "./harness.ts";

const seedThread = (api: import("./harness.ts").FakeApi) => {
  api.seedThread({
    id: "t-1",
    name: "w-reconcile",
    title: "Fix the reconcile bug",
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
};

test("the conversation renders the session transcript", async ({
  page,
  api,
}) => {
  seedThread(api);
  api.seedTurn(
    "Thread:t-1",
    "how is the fix going?",
    "The engineer is mid-way; tests pass locally.",
  );
  await openApp(page, threadPath("t-1"));

  await expect(main(page)).toContainText("how is the fix going?");
  await expect(main(page)).toContainText(
    "The engineer is mid-way; tests pass locally.",
  );
});

test("right-click a chat message: Delete redacts it from the transcript", async ({
  page,
  api,
}) => {
  seedThread(api);
  api.seedTurn("Thread:t-1", "first question", "first answer");
  api.seedTurn("Thread:t-1", "delete this one", "second answer");
  await openApp(page, threadPath("t-1"));
  await expect(main(page)).toContainText("delete this one");

  // right-click the user message, Delete, confirm — the row hides at
  // once and the DELETE lands on the transcript endpoint
  const row = main(page)
    .locator("[data-message-id]", { hasText: "delete this one" })
    .first();
  await row.click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Delete" }).click();

  await expect
    .poll(() => api.deletedChatMessages)
    .toEqual([{ id: "Thread:t-1", messageId: "u-2" }]);
  await expect(main(page)).not.toContainText("delete this one");
  // the rest of the conversation survives
  await expect(main(page)).toContainText("first question");
  await expect(main(page)).toContainText("second answer");
});

test("a tool call renders as its card", async ({ page, api }) => {
  seedThread(api);
  api.seedTool("Thread:t-1", {
    ask: "get a worktree for the PR",
    name: "worktree",
    input: { ref: `${REPO}#148` },
    output: { path: "/workspace/trees/pr-148", branch: "pr-148" },
    reply: "Worktree ready.",
  });
  await openApp(page, threadPath("t-1"));

  await expect(main(page)).toContainText("Worktree for");
  await expect(main(page)).toContainText(`${REPO}#148`);
});

test("the stop button interrupts the round in flight; the turn ends", async ({
  page,
  api,
}) => {
  seedThread(api);
  api.seedOpenRound("Thread:t-1", {
    ask: "review the PR",
    name: "worktree",
    input: { ref: `${REPO}#148` },
  });
  await openApp(page, threadPath("t-1"));

  // a round is open: the composer's button is STOP
  const stop = main(page).getByRole("button", { name: "Stop" });
  await expect(stop).toBeVisible();
  await stop.click();
  await expect.poll(() => api.interrupted).toEqual(["Thread:t-1"]);

  // the `aborted` observation ends the turn: the marker lands and the
  // button is a plain submit again — the session is still there to
  // talk to
  await expect(main(page).locator("[data-aborted]")).toHaveText("Stopped");
  await expect(stop).toBeHidden();
  await expect(
    main(page).getByRole("button", { name: "Submit" }),
  ).toBeVisible();
});

test("the state pane shows entities, agents, and the worktree", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1"));

  const pane = page.getByRole("complementary", { name: "Thread state" });
  await expect(pane).toContainText("Bug in reconcile");
  await expect(pane).toContainText("Add sumToN helper");
  await expect(pane).toContainText("pr-148");
  await expect(
    pane.getByRole("button", {
      name: "copy worktree path /workspace/trees/pr-148",
    }),
  ).toBeVisible();
  await expect(pane).toContainText("engineer");
  await expect(pane).toMatchAriaSnapshot({ name: "thread-pane.aria.yml" });
});

test("an agent row opens the subagent's session; close returns to chat", async ({
  page,
  api,
}) => {
  seedThread(api);
  // the engineer's own transcript — a tool call the THREAD never saw
  api.seedBash("Engineer:engineer-1", {
    ask: "Implement the fix in pr-148's worktree",
    command: "pnpm test test/reconcile",
    stdout: "3 passed",
    reply: "Tests are green in the worktree.",
  });
  await openApp(page, threadPath("t-1"));
  await expect(main(page)).not.toContainText("pnpm test test/reconcile");

  await page
    .getByRole("complementary", { name: "Thread state" })
    .getByRole("button", { name: "open agent engineer-1" })
    .click();
  await expect(page).toHaveURL(/\/t-1\/agent\/engineer-1$/);

  // the body is now the engineer's session: its brief, its status,
  // its tool calls — read-only, the thread stays the point of contact
  const session = main(page).locator("[data-agent-session='engineer-1']");
  await expect(session).toContainText("working");
  await expect(session).toContainText("pnpm test test/reconcile");
  await expect(session).toContainText("Tests are green in the worktree.");
  await expect(session.getByRole("button", { name: "Submit" })).toHaveCount(0);

  await page.getByRole("button", { name: "close agent" }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
  await expect(main(page)).not.toContainText("pnpm test test/reconcile");
});

test("the Engineer card's open button jumps to the running agent", async ({
  page,
  api,
}) => {
  seedThread(api);
  // the spawn is still in flight: no key on the wire yet — the card
  // finds its agent by the brief
  api.seedOpenRound("Thread:t-1", {
    ask: "fix the reconcile bug",
    name: "spawn",
    input: { brief: "Implement the fix in pr-148's worktree" },
  });
  await openApp(page, threadPath("t-1"));

  await main(page)
    .getByRole("button", { name: "Open the agent's session", exact: true })
    .click();
  await expect(page).toHaveURL(/\/t-1\/agent\/engineer-1$/);
  await expect(
    main(page).locator("[data-agent-session='engineer-1']"),
  ).toContainText("Implement the fix in pr-148's worktree");
});

test("a pull entity opens its review tab; the diff renders", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1"));

  await page
    .getByRole("complementary", { name: "Thread state" })
    .getByRole("button", { name: `open review for ${REPO}#148` })
    .click();
  await expect(page).toHaveURL(/\/t-1\/alchemy-run\/test-alchemy\/pull\/148$/);
  await expect(main(page)).toContainText("Add sumToN helper");
  await expect(main(page)).toContainText("flow-test/sum.ts");
  expect(api.pullLoads).toEqual([148]);
});

test("+ opens a terminal on the thread's machine; close returns to chat", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1"));

  await page.getByRole("button", { name: "new terminal" }).click();
  await expect(page).toHaveURL(/\/terminal\//);
  // the viewer's status line proves the socket; the prompt's BYTES
  // land in ghostty's canvas, not the DOM — assert on the fake's books
  await expect(main(page)).toContainText("connected");
  await expect.poll(() => api.terminal.opened.length).toBe(1);

  await page.getByRole("button", { name: /close terminal/ }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
});

test("close thread posts and the header shows closed", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1"));

  await page.getByRole("button", { name: "Close thread" }).click();
  await expect.poll(() => api.closedThreads).toEqual(["t-1"]);
  // the fake pushes the closed state over the thread socket
  await expect(main(page)).toContainText("closed");
});

test("delete thread confirms, erases, and returns to the channel", async ({
  page,
  api,
}) => {
  seedThread(api);
  api.seedThread({ id: "t-2", name: "w-other", title: "Another task" });
  await openApp(page, threadPath("t-1"));
  const nav = (name: string) =>
    threadNav(page).getByRole("button", { name, exact: true });
  await expect(nav("w-reconcile")).toBeVisible();

  // a dismissed confirm deletes nothing
  page.once("dialog", (dialog) => void dialog.dismiss());
  await main(page).getByRole("button", { name: "Delete thread" }).click();
  await expect.poll(() => api.deletedThreads).toEqual([]);
  await expect(nav("w-reconcile")).toBeVisible();

  // accepted: the DELETE lands, the rail forgets the thread, and the
  // view falls back to the channel
  page.once("dialog", (dialog) => void dialog.accept());
  await main(page).getByRole("button", { name: "Delete thread" }).click();
  await expect.poll(() => api.deletedThreads).toEqual(["t-1"]);
  await expect(nav("w-reconcile")).toHaveCount(0);
  await expect(nav("w-other")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  await expect(
    page.getByRole("textbox", { name: "Message the channel" }),
  ).toBeVisible();
});

test("a review URL deep-links straight into the diff", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, `${threadPath("t-1")}/alchemy-run/test-alchemy/pull/148`);
  await expect(main(page)).toContainText("flow-test/sum.ts");
});
