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

test("the state pane shows entities, agents, and the worktree", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1"));

  const pane = page.getByRole("complementary", { name: "Thread state" });
  await expect(pane).toContainText("Bug in reconcile");
  await expect(pane).toContainText("Add sumToN helper");
  await expect(pane).toContainText("trees/pr-148");
  await expect(pane).toContainText("engineer");
  await expect(pane).toMatchAriaSnapshot({ name: "thread-pane.aria.yml" });
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

test("a review URL deep-links straight into the diff", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, `${threadPath("t-1")}/alchemy-run/test-alchemy/pull/148`);
  await expect(main(page)).toContainText("flow-test/sum.ts");
});
