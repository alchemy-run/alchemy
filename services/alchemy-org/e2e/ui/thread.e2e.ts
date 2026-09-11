/**
 * A THREAD's page — the conversation (the agent session's transcript
 * over the run socket), the state pane (assigned, agents), the tabs
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
        cwd: "/workspace/trees/pr-148",
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

test("the thread's bookkeeping renders as timeline rows, not bubbles", async ({
  page,
  api,
}) => {
  seedThread(api);
  // what the thread tells its agent on the channel's behalf
  api.seedInput(
    "Thread:t-1",
    `[assigned] ${REPO}#148 — pull, open — Add sumToN helper`,
  );
  api.seedInput(
    "Thread:t-1",
    `[channel] danieljvdm · 2026-09-08T20:25:21.187Z\nopened pull request #148 — Add sumToN helper\nwith a second line`,
  );
  api.seedInput("Thread:t-1", `[unassigned] ${REPO}#148`);
  api.seedTurn("Thread:t-1", "go", "Going.");
  await openApp(page, threadPath("t-1"));

  const assigned = main(page).locator("[data-thread-note='assigned']");
  await expect(assigned).toContainText("assigned");
  await expect(assigned).toContainText("Add sumToN helper");
  await expect(assigned).toContainText("open");
  await expect(assigned.getByRole("link", { name: "#148" })).toHaveAttribute(
    "href",
    `https://github.com/${REPO}/issues/148`,
  );
  // the prefix itself never shows — it is the row's icon and verb now
  await expect(main(page)).not.toContainText("[assigned]");
  await expect(main(page)).not.toContainText("[channel]");
  await expect(main(page)).not.toContainText("2026-09-08T20:25:21");

  const channel = main(page).locator("[data-thread-note='channel']");
  await expect(channel).toContainText("danieljvdm");
  await expect(channel).toContainText("opened pull request");
  await expect(channel).not.toContainText("with a second line");
  await channel.getByRole("button").click();
  await expect(channel).toContainText("with a second line");

  await expect(
    main(page).locator("[data-thread-note='unassigned']"),
  ).toContainText("unassigned");
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

const worktreeCall = (n: number, isFailure = false) => ({
  name: "worktree",
  input: { ref: `${REPO}#${n}` },
  output: isFailure
    ? `CheckoutFailed: ${REPO}#${n} has no head`
    : { path: `/workspace/trees/pr-${n}`, branch: `pr-${n}` },
  isFailure,
});

test("a run of one tool folds into one line that opens into its cards", async ({
  page,
  api,
}) => {
  seedThread(api);
  api.seedTools("Thread:t-1", {
    ask: "make a worktree for each of the five pulls",
    calls: [1521, 1522, 1523, 1524, 1525].map((n) => worktreeCall(n)),
    reply: "Five worktrees ready.",
  });
  await openApp(page, threadPath("t-1"));

  // ONE line, not five cards
  const run = main(page).locator("[data-tool-run='worktree']");
  await expect(run).toHaveCount(1);
  await expect(run).toHaveAttribute("data-count", "5");
  await expect(run).toContainText("Created 5 worktrees");
  await expect(main(page).locator("[data-tool='worktree']")).toHaveCount(0);
  await expect(main(page)).not.toContainText(`${REPO}#1523`);

  // open: the five cards, in order; close: back to the line
  await run.getByRole("button", { expanded: false }).click();
  const cards = main(page).locator("[data-tool='worktree']");
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(0)).toContainText(`${REPO}#1521`);
  await expect(cards.nth(4)).toContainText(`${REPO}#1525`);
  await expect(cards.nth(4)).toContainText("pr-1525");
  await run.getByRole("button", { expanded: true }).click();
  await expect(main(page).locator("[data-tool='worktree']")).toHaveCount(0);
});

test("a run with a failure opens by default and counts it in the line", async ({
  page,
  api,
}) => {
  seedThread(api);
  api.seedTools("Thread:t-1", {
    ask: "make a worktree for each pull",
    calls: [worktreeCall(1521), worktreeCall(1522, true), worktreeCall(1523)],
    reply: "Two of three worktrees ready; #1522 has no head.",
  });
  await openApp(page, threadPath("t-1"));

  const run = main(page).locator("[data-tool-run='worktree']");
  await expect(run).toContainText("Created 3 worktrees");
  await expect(run).toContainText("1 failed");
  // open already — the failure is the story
  await expect(run.getByRole("button", { expanded: true })).toBeVisible();
  await expect(main(page).locator("[data-tool='worktree']")).toHaveCount(3);
  await expect(main(page)).toContainText("CheckoutFailed");
});

test("a run in flight says so: present tense, and how many are still running", async ({
  page,
  api,
}) => {
  seedThread(api);
  api.seedTools("Thread:t-1", {
    ask: "make a worktree for each pull",
    calls: [
      worktreeCall(1521),
      worktreeCall(1522),
      worktreeCall(1523),
      { ...worktreeCall(1524), open: true },
      { ...worktreeCall(1525), open: true },
    ],
    reply: "",
  });
  await openApp(page, threadPath("t-1"));

  const run = main(page).locator("[data-tool-run='worktree']");
  await expect(run).toContainText("Creating 5 worktrees");
  await expect(run).toContainText("2 running…");
  await run.getByRole("button", { expanded: false }).click();
  const cards = main(page).locator("[data-tool='worktree']");
  await expect(cards).toHaveCount(5);
  await expect(cards.nth(3)).toContainText("running…");
  await expect(cards.nth(0)).not.toContainText("running…");
});

test("two calls stay two cards; a different tool between calls breaks the run", async ({
  page,
  api,
}) => {
  seedThread(api);
  api.seedTools("Thread:t-1", {
    ask: "worktrees for both",
    calls: [worktreeCall(1521), worktreeCall(1522)],
    reply: "Two worktrees ready.",
  });
  api.seedTools("Thread:t-1", {
    ask: "now the other three, and check the state between",
    calls: [
      worktreeCall(1523),
      worktreeCall(1524),
      {
        name: "read_state",
        input: {},
        output: {
          state: {
            id: "t-1",
            name: "w-reconcile",
            title: "Fix the reconcile bug",
            status: "open",
            turn: "agents",
            assigned: [],
            agents: [],
          },
        },
      },
      worktreeCall(1525),
    ],
    reply: "Done.",
  });
  await openApp(page, threadPath("t-1"));

  // below the threshold, and broken by read_state: no fold anywhere,
  // every card on the page
  await expect(main(page).locator("[data-tool-run]")).toHaveCount(0);
  await expect(main(page).locator("[data-tool='worktree']")).toHaveCount(5);
  await expect(main(page).locator("[data-tool='read_state']")).toHaveCount(1);
});

test("read_state renders the thread state: assigned and agents, counted", async ({
  page,
  api,
}) => {
  seedThread(api);
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
            brief: "Fix it",
            state: "running",
          },
          {
            key: "engineer-2",
            kind: "engineer",
            brief: "Test it",
            state: "done",
          },
        ],
      },
    },
    reply: "One engineer is still working.",
  });
  await openApp(page, threadPath("t-1"));

  const card = main(page).locator("[data-tool='read_state']");
  await expect(card).toContainText("Read the thread's state");
  await expect(card).toContainText("open · 2 assigned · 2 agents (1 working)");
  await card.getByRole("button").first().click();
  await expect(card).toContainText("Assigned · 2");
  await expect(card).toContainText(`${REPO}#148`);
  await expect(card).toContainText("pr-148");
  await expect(card).toContainText("Agents · 2");
  await expect(card).toContainText("Fix it");
  await expect(card).toContainText("done");
});

test("a view opened mid-handler sees the in-flight call; the round lands into that one card", async ({
  page,
  api,
}) => {
  seedThread(api);
  // the model called worktree; its handler is running — the page loads
  // NOW, with nothing but the durable tool-call row to go on
  const callId = api.seedOpenRound("Thread:t-1", {
    ask: "get a worktree for the PR",
    name: "worktree",
    input: { ref: `${REPO}#148` },
  });
  await openApp(page, threadPath("t-1"));

  const card = main(page).getByRole("button", { name: /^Worktree for/ });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("running…");
  await expect(
    main(page).getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();

  // the handler returns: the sampling's `assistant` row restates the
  // call, the result lands, the model replies — still ONE card, now
  // complete, and the turn is over
  api.landOpenRound("Thread:t-1", callId, {
    name: "worktree",
    input: { ref: `${REPO}#148` },
    output: { path: "/workspace/trees/pr-148", branch: "pr-148" },
    reply: "Worktree ready.",
  });
  await expect(main(page)).toContainText("Worktree ready.");
  await expect(card).toHaveCount(1);
  await expect(main(page)).toContainText("/workspace/trees/pr-148");
  await expect(
    main(page).getByRole("button", { name: "Submit" }),
  ).toBeVisible();
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
  const stop = main(page).getByRole("button", { name: "Stop", exact: true });
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

  // the call the stop cut short is CLOSED: the round that owed its
  // result is over, so the card does not run forever — it says so
  const card = main(page).locator("[data-tool='worktree']");
  await expect(card).not.toContainText("running…");
  await expect(card).toContainText("stopped — the round ended");
});

test("a spawn card reads the thread state: a stopped or deleted engineer is not 'working', whatever the open call says", async ({
  page,
  api,
}) => {
  seedThread(api);
  // the spawn call is open on the wire (no key yet — the card matches
  // its agent by the brief), and the thread state says the engineer is running
  api.seedOpenRound("Thread:t-1", {
    ask: "fix the reconcile bug",
    name: "spawn",
    input: { brief: "Implement the fix in pr-148's worktree" },
  });
  await openApp(page, threadPath("t-1"));
  const card = main(page).locator("[data-tool='spawn']");
  await expect(card).toContainText("running…");
  await expect(card).toContainText("working");

  // the operator stops the engineer: the transcript still owes the
  // call its result, but the thread state outranks it — the card says stopped
  await agentRow(page, "engineer-1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stop agent" }).click();
  await expect(agentRow(page, "engineer-1")).toHaveAttribute(
    "data-state",
    "stopped",
  );
  await expect(card).not.toContainText("running…");
  await expect(card).not.toContainText("working");
  await expect(card.locator("[data-settled]")).toHaveText("stopped");

  // …and deleted: the row is gone from the thread state, so is the "working"
  page.once("dialog", (dialog) => void dialog.accept());
  await agentRow(page, "engineer-1").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete agent" }).click();
  await expect(agentRow(page, "engineer-1")).toHaveCount(0);
  await expect(card.locator("[data-settled]")).toHaveText("deleted");
  await expect(card).not.toContainText("working");
});

test("the state pane shows assigned refs, agents, and the worktree", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1"));

  const pane = page.getByRole("complementary", { name: "Thread state" });
  await expect(pane).toContainText("Bug in reconcile");
  await expect(pane).toContainText("Add sumToN helper");
  await expect(pane).toContainText("pr-148");
  // the worktree is a chip on the assignment AND a row of its own
  // section (path, pull request, the engineers rooted in it)
  await expect(
    pane.getByRole("button", {
      name: "copy worktree path /workspace/trees/pr-148",
    }),
  ).toHaveCount(2);
  await expect(
    pane.locator("[data-worktree='/workspace/trees/pr-148']"),
  ).toContainText("engineer");
  await expect(
    pane.locator("[data-worktree='/workspace/trees/pr-148']"),
  ).toContainText("#148");
  // the manager leads the agents — the thread's own agent, first
  await expect(pane.locator("[data-manager]")).toContainText("manager");
  await expect(pane).toContainText("engineer");
  await expect(pane).toMatchAriaSnapshot({ name: "thread-pane.aria.yml" });
});

test("a crowded thread stays in bounds: sections count and scroll, the tab strip never grows the header", async ({
  page,
  api,
}) => {
  const pulls = Array.from({ length: 24 }, (_, i) => ({
    ref: `${REPO}#${1500 + i}`,
    kind: "pull" as const,
    state: "open",
    title: `fix(aws): small fix number ${i + 1} with a title long enough to truncate`,
  }));
  api.seedThread({
    id: "t-1",
    name: "aws-small-fixes",
    title: "Small AWS provider fixes — recent sweep",
    assigned: [
      { ref: `${REPO}#12`, kind: "issue", state: "open", title: "Tracking" },
      ...pulls,
    ],
    agents: Array.from({ length: 30 }, (_, i) => ({
      key: `engineer-${i + 1}`,
      kind: "engineer",
      brief: `Review pull ${1500 + i}`,
      cwd: `/workspace/trees/pr-${1500 + i}`,
      state: "done" as const,
      startedAt: NOW.getTime() - 120_000,
    })),
  });
  await openApp(page, threadPath("t-1"));

  // the summary says how much without reading the list
  const pane = page.getByRole("complementary", { name: "Thread state" });

  // the manager is pinned: scroll the agents list to its end and the
  // manager row still sits at the top of the section, above the rest
  const agentsSection = pane.locator("[data-section=agents]");
  const manager = agentsSection.locator("[data-manager]");
  const last = agentsSection.getByRole("button", {
    name: "open agent engineer-30",
  });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  await expect(manager).toBeInViewport();
  const managerBox = (await manager.boundingBox())!;
  const lastBox = (await last.boundingBox())!;
  expect(managerBox.y).toBeLessThan(lastBox.y);
  const assigned = pane.locator("[data-section=assigned]");
  await expect(
    assigned.getByRole("button", { name: "Assigned · 24 pulls · 1 issue" }),
  ).toBeVisible();
  // …and the list scrolls INSIDE its section: Worktrees and Agents are
  // still on screen below it
  const box = (await assigned.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.height).toBeLessThan(viewport.height * 0.6);
  await expect(pane.locator("[data-section=worktrees]")).toBeInViewport();
  await expect(pane.locator("[data-section=agents]")).toBeInViewport();
  // folding the section leaves the summary
  await assigned.getByRole("button", { name: /^Assigned/ }).click();
  await expect(assigned).not.toContainText("small fix number 1");
  await expect(assigned).toContainText("24 pulls");

  // the pulls are NOT tabs: the strip holds the manager (and agents,
  // terminals) — 24 assignments add nothing up there
  const strip = page.locator("[data-tabs]");
  await expect(strip.locator("[data-review-tab]")).toHaveCount(0);
  await expect(strip.getByRole("button")).toHaveCount(2); // manager, +

  // clicking a pull's ROW opens its review (the diff takes the body);
  // the strip shows that one pull as a temporary tab, and closing the
  // tab returns to the manager
  await assigned.getByRole("button", { name: /^Assigned/ }).click();
  await pane.locator(`[data-assigned="${REPO}#1505"]`).click();
  await expect(page).toHaveURL(/\/pull\/1505$/);
  await expect(strip.locator("[data-review-tab]")).toHaveText(/#1505/);
  await strip.getByRole("button", { name: "close review" }).click();
  await expect(strip.locator("[data-review-tab]")).toHaveCount(0);
  await expect(page).toHaveURL(/\/t-1$/);
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
  // its tool calls — and, while it works, a prompt to steer it by
  const session = main(page).locator("[data-agent-session='engineer-1']");
  await expect(session).toContainText("working");
  await expect(session).toContainText("pnpm test test/reconcile");
  await expect(session).toContainText("Tests are green in the worktree.");
  await expect(session.getByRole("button", { name: "Submit" })).toBeVisible();

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
  // the strip above the session is the basic controls — kind and
  // state, not the brief (the transcript's first message says that)
  const session = main(page).locator("[data-agent-session='engineer-1']");
  await expect(session).toContainText("engineer");
  await expect(session).toContainText("working");
  await expect(session).not.toContainText("Implement the fix");
});

const agentRow = (page: import("@playwright/test").Page, key: string) =>
  page
    .getByRole("complementary", { name: "Thread state" })
    .locator(`[data-agent='${key}']`);

test("right-click on an agent: Stop settles it, Resume brings it back", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1"));

  // a running agent's menu offers Stop, not Resume
  await agentRow(page, "engineer-1").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Open" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Resume" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Stop agent" }).click();
  await expect
    .poll(() => api.agentActions)
    .toEqual([{ thread: "t-1", key: "engineer-1", action: "stop" }]);
  // the thread's state frame carries the outcome
  await expect(agentRow(page, "engineer-1")).toHaveAttribute(
    "data-state",
    "stopped",
  );

  // a stopped agent's menu offers Resume, not Stop
  await agentRow(page, "engineer-1").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Stop" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Resume agent" }).click();
  await expect
    .poll(() => api.agentActions.at(-1))
    .toEqual({
      thread: "t-1",
      key: "engineer-1",
      action: "resume",
    });
  await expect(agentRow(page, "engineer-1")).toHaveAttribute(
    "data-state",
    "running",
  );
});

test("the agent pane's controls: Stop shows the request in flight; the prompt follows the state", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1") + "/agent/engineer-1");
  const session = main(page).locator("[data-agent-session='engineer-1']");
  const controls = session.getByRole("toolbar", { name: "agent controls" });

  // a running agent takes input — the operator can steer it
  await expect(session.getByRole("button", { name: "Submit" })).toBeVisible();
  await expect(
    controls.getByRole("button", { name: "stop agent" }),
  ).toBeVisible();
  await expect(
    controls.getByRole("button", { name: "resume agent" }),
  ).toHaveCount(0);

  // stop: the row is busy until the server answers, then it reads stopped
  const release = api.holdAgentActions();
  await controls.getByRole("button", { name: "stop agent" }).click();
  await expect(agentRow(page, "engineer-1")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(
    controls.getByRole("button", { name: "stop agent" }),
  ).toBeDisabled();
  release();
  await expect(agentRow(page, "engineer-1")).not.toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect(session).toContainText("stopped");

  // a settled agent ignores input: no prompt, Resume in its place
  await expect(session.getByRole("button", { name: "Submit" })).toHaveCount(0);
  await controls.getByRole("button", { name: "resume agent" }).click();
  await expect(session).toContainText("working");
  await expect(session.getByRole("button", { name: "Submit" })).toBeVisible();
  expect(api.agentActions.map((entry) => entry.action)).toEqual([
    "stop",
    "resume",
  ]);
});

test("deleting an agent from its pane confirms, erases it, and returns to the chat", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1") + "/agent/engineer-1");
  const controls = main(page)
    .locator("[data-agent-session='engineer-1']")
    .getByRole("toolbar", { name: "agent controls" });

  // dismissed: nothing happens
  page.once("dialog", (dialog) => void dialog.dismiss());
  await controls.getByRole("button", { name: "delete agent" }).click();
  await expect(agentRow(page, "engineer-1")).toBeVisible();
  expect(api.agentActions).toEqual([]);

  // accepted: the row goes, the pane closes onto the conversation
  page.once("dialog", (dialog) => void dialog.accept());
  await controls.getByRole("button", { name: "delete agent" }).click();
  await expect
    .poll(() => api.agentActions)
    .toEqual([{ thread: "t-1", key: "engineer-1", action: "delete" }]);
  await expect(agentRow(page, "engineer-1")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
  await expect(
    page.getByRole("complementary", { name: "Thread state" }),
  ).toContainText("No engineers yet.");
});

test("⌘-click selects several agents; the menu acts on all of them", async ({
  page,
  api,
}) => {
  api.seedThread({
    id: "t-1",
    name: "w-reconcile",
    agents: [
      {
        key: "engineer-1",
        kind: "engineer",
        brief: "one",
        state: "running",
        startedAt: NOW.getTime() - 120_000,
      },
      {
        key: "engineer-2",
        kind: "engineer",
        brief: "two",
        state: "done",
        startedAt: NOW.getTime() - 100_000,
        settledAt: NOW.getTime() - 50_000,
      },
      {
        key: "engineer-3",
        kind: "engineer",
        brief: "three",
        state: "running",
        startedAt: NOW.getTime() - 60_000,
      },
    ],
  });
  await openApp(page, threadPath("t-1"));

  await agentRow(page, "engineer-1").click();
  await agentRow(page, "engineer-3").click({ modifiers: ["ControlOrMeta"] });
  await agentRow(page, "engineer-3").click({ button: "right" });
  // no Open for several; one Stop for the two running ones
  await expect(page.getByRole("menuitem", { name: "Open" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Stop 2 agents" }).click();
  await expect
    .poll(() => api.agentActions.map((entry) => entry.key).sort())
    .toEqual(["engineer-1", "engineer-3"]);
  await expect(agentRow(page, "engineer-3")).toHaveAttribute(
    "data-state",
    "stopped",
  );

  // ⇧-click ranges; a mixed selection offers both switches, and Delete
  // names the count
  await agentRow(page, "engineer-1").click();
  await agentRow(page, "engineer-3").click({ modifiers: ["Shift"] });
  await agentRow(page, "engineer-2").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Resume 3 agents" }),
  ).toBeVisible();
  await expect(
    page.getByRole("menuitem", { name: "Delete 3 agents" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});

test("the Agents heading's switches act on every agent in ONE request: Stop all, Resume all, Delete all", async ({
  page,
  api,
}) => {
  api.seedThread({
    id: "t-1",
    name: "w-reconcile",
    agents: [
      {
        key: "engineer-1",
        kind: "engineer",
        brief: "one",
        state: "running",
        startedAt: NOW.getTime() - 120_000,
      },
      {
        key: "engineer-2",
        kind: "engineer",
        brief: "two",
        state: "done",
        startedAt: NOW.getTime() - 100_000,
        settledAt: NOW.getTime() - 50_000,
      },
      {
        key: "engineer-3",
        kind: "engineer",
        brief: "three",
        state: "running",
        startedAt: NOW.getTime() - 60_000,
      },
    ],
  });
  await openApp(page, threadPath("t-1"));
  const pane = page.getByRole("complementary", { name: "Thread state" });

  // two working: Stop all names the count and stops exactly those
  await expect(
    pane.getByRole("button", { name: "Resume all", exact: false }),
  ).toHaveCount(0);
  await pane.getByRole("button", { name: "Stop all (2)" }).click();
  await expect
    .poll(() => api.agentActions.map((entry) => entry.key).sort())
    .toEqual(["engineer-1", "engineer-3"]);
  expect(api.bulkRequests).toBe(1);
  for (const key of ["engineer-1", "engineer-2", "engineer-3"]) {
    await expect(agentRow(page, key)).not.toHaveAttribute(
      "data-state",
      "running",
    );
  }

  // none working: Resume all takes its place and brings every one back
  await expect(pane.getByRole("button", { name: /^Stop all/ })).toHaveCount(0);
  await pane.getByRole("button", { name: "Resume all (3)" }).click();
  await expect
    .poll(() => api.agentActions.filter((e) => e.action === "resume").length)
    .toBe(3);
  expect(api.bulkRequests).toBe(2);
  await expect(agentRow(page, "engineer-2")).toHaveAttribute(
    "data-state",
    "running",
  );

  // Delete all confirms, then the thread state is empty
  page.once("dialog", (dialog) => void dialog.accept());
  await pane.getByRole("button", { name: "Delete all" }).click();
  await expect(pane).toContainText("No engineers yet.");
  expect(api.bulkRequests).toBe(3);
  expect(api.agentActions.filter((e) => e.action === "delete")).toHaveLength(3);
});

test("an assigned pull opens its review tab; the diff renders", async ({
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
  // land in ghostty's canvas, not the DOM — assert on the fake's record
  await expect(main(page)).toContainText("connected");
  await expect.poll(() => api.terminal.opened.length).toBe(1);

  await page.getByRole("button", { name: /close terminal/ }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
});

test("the model selector: the thread's pick lands as PUT on its session and the pane follows the state", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, threadPath("t-1"));

  const pane = page.getByRole("complementary", { name: "Thread state" });
  const select = pane.getByRole("combobox", { name: "Thread model" });
  // nothing chosen: the default, named
  await expect(select).toHaveAttribute("data-model", "default");
  await expect(select).toContainText("Default");
  await expect(select).toContainText("Claude Haiku 4.5");

  // pick Opus: one PUT on the thread's session, the state push re-renders
  await select.click();
  await page.getByRole("option", { name: /Claude Opus 4.1/ }).click();
  await expect
    .poll(() => api.modelPicks)
    .toEqual([{ session: "Thread:t-1", model: "claude-opus-4-1" }]);
  await expect(select).toHaveAttribute("data-model", "claude-opus-4-1");
  await expect(select).toContainText("Claude Opus 4.1");
  expect(api.threads["t-1"]?.model).toBe("claude-opus-4-1");

  // back to the default: `null` on the wire, the field leaves the state
  await select.click();
  await page.getByRole("option", { name: /^Default/ }).click();
  await expect.poll(() => api.modelPicks.length).toBe(2);
  expect(api.modelPicks[1]).toEqual({ session: "Thread:t-1", model: null });
  await expect(select).toHaveAttribute("data-model", "default");
  expect(api.threads["t-1"]?.model).toBeUndefined();
});

test("an engineer's pane has its own selector: read over GET, written on its session", async ({
  page,
  api,
}) => {
  seedThread(api);
  api.engineerModels["engineer-1"] = "gpt-5-mini";
  await openApp(page, threadPath("t-1"));
  await agentRow(page, "engineer-1").click();

  const select = page.getByRole("combobox", { name: "Agent model" });
  await expect(select).toHaveAttribute("data-model", "gpt-5-mini");
  await expect(select).toContainText("GPT-5 mini");

  await select.click();
  await page.getByRole("option", { name: /^GPT-5 openai/ }).click();
  await expect
    .poll(() => api.modelPicks)
    .toEqual([{ session: "Engineer:engineer-1", model: "gpt-5" }]);
  await expect(select).toContainText("GPT-5");
  // the thread's own pick is untouched
  expect(api.threads["t-1"]?.model).toBeUndefined();
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

test("a thread whose state is gone still shows a pane — and can be deleted", async ({
  page,
  api,
}) => {
  // the rail lists it (its directory row survived) but the server
  // answers 404 for its state: a thread made under an earlier storage
  // layout, or one whose state was lost
  api.seedOrphanRow({
    id: "t-ghost-9612478f",
    name: "cloudflare-state-fixes",
    title: "Cloudflare container & state payload fixes",
  });
  api.seedThread({ id: "t-2", name: "w-other", title: "Another task" });
  await openApp(page, threadPath("t-ghost-9612478f"));
  const nav = (name: string) =>
    threadNav(page).getByRole("button", { name, exact: true });
  await expect(nav("cloudflare-state-fixes")).toBeVisible();

  // the pane is there, saying what happened, with the way out
  const pane = page.getByRole("complementary", { name: "Thread state" });
  await expect(pane).toBeVisible();
  await expect(pane).toContainText("state missing");
  await expect(pane).toContainText("t-ghost-9612478f");

  page.once("dialog", (dialog) => void dialog.accept());
  await pane.getByRole("button", { name: "Delete thread" }).click();
  await expect.poll(() => api.deletedThreads).toEqual(["t-ghost-9612478f"]);
  await expect(nav("cloudflare-state-fixes")).toHaveCount(0);
  await expect(nav("w-other")).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("a review URL deep-links straight into the diff", async ({
  page,
  api,
}) => {
  seedThread(api);
  await openApp(page, `${threadPath("t-1")}/alchemy-run/test-alchemy/pull/148`);
  await expect(main(page)).toContainText("flow-test/sum.ts");
});
