/**
 * The ONE page and its overlays, against the fake backend
 * (`harness.ts`): the Root channel renders the Head's session and
 * posts into it; an `ask` tool card opens into its nested chain; the
 * `?workspace=` overlay dials the workspace's terminal socket; the
 * `?call=` overlay streams a call's thread and lets the human join;
 * the Inbound pane is the triage valve (held events released by
 * hand); the Engineering pane shows the manager's feed, the task
 * ledger, and the pending proposals; closing any overlay returns
 * to `/`.
 */
import {
  expect,
  test,
  openApp,
  NOW,
  ROOT_CHAT,
  MANAGER_CHAT,
} from "./harness";

test.describe("the Root channel", () => {
  test("renders the seeded conversation", async ({ page, api }) => {
    api.seedTurn(
      ROOT_CHAT,
      "good morning — where do we stand?",
      "All quiet. Two pulls await review; the D1 flake is being chased.",
    );
    await openApp(page);
    await expect(
      page.getByText("good morning — where do we stand?"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "All quiet. Two pulls await review; the D1 flake is being chased.",
      ),
    ).toBeVisible();
  });

  test("the composer posts to the Head", async ({ page, api }) => {
    await openApp(page);
    const composer = page.getByPlaceholder("Talk to the Head…");
    await composer.fill("ship the release branch");
    await composer.press("Enter");
    // the submit rides the session socket; the fake records it as the
    // Root post and echoes the durable input row back
    await expect
      .poll(() => api.root.posted)
      .toContain("ship the release branch");
    await expect(page.getByText("ship the release branch")).toBeVisible();
  });
});

test.describe("the ask tool card", () => {
  test("renders the nested chain", async ({ page, api }) => {
    api.seedTool(ROOT_CHAT, {
      ask: "can we ship 1521?",
      name: "ask",
      input: {
        agent: "engineering-manager",
        question: "can we ship 1521?",
      },
      output: { answer: "yes, pending the merge proposal", ask: "a-1" },
      reply: "The manager says yes — pending the merge proposal.",
    });
    api.seedAskTree({
      id: "a-1",
      asker: "head",
      target: "engineering-manager",
      question: "can we ship 1521?",
      answer: "yes, pending the merge proposal",
      status: "answered",
      at: NOW.getTime() - 300_000,
      children: [
        {
          id: "a-2",
          parent: "a-1",
          asker: "engineering-manager",
          target: "e-4f2a",
          question: "is the D1 flake understood?",
          answer: "yes — fencepost in the retry; fix pushed",
          status: "answered",
          at: NOW.getTime() - 240_000,
          children: [],
        },
      ],
    });
    await openApp(page);

    const card = page.locator("[data-tool='ask']");
    await expect(card).toBeVisible();
    await expect(card).toContainText("engineering-manager");
    // the chain lives behind the card's header — expand it
    await card.getByRole("button").first().click();

    // the whole tree, reddit-style: the root node, the child NESTED
    // inside it, its question, and both answers
    await expect(page.locator("[data-ask='a-1']")).toBeVisible();
    await expect(
      page.locator("[data-ask='a-1'] [data-ask='a-2']"),
    ).toBeVisible();
    await expect(
      page.getByText("is the D1 flake understood?"),
    ).toBeVisible();
    await expect(
      page.getByText("yes — fencepost in the retry; fix pushed"),
    ).toBeVisible();
    await expect(
      page.locator("[data-ask='a-1']").getByText(
        "yes, pending the merge proposal",
      ),
    ).toBeVisible();
  });
});

test.describe("the workspace overlay", () => {
  test("dials the workspace's terminal socket", async ({ page, api }) => {
    await openApp(page, "/?workspace=pr-1");
    await expect.poll(() => api.terminal.opened.length).toBe(1);
    expect(api.terminal.opened[0]).toBe("main");
    expect(decodeURIComponent(api.terminal.sockets[0]!)).toContain(
      "/terminal/Workspace/root::ws-pr-1",
    );
  });
});

test.describe("the call overlay", () => {
  test("streams the thread and lets the human join", async ({ page, api }) => {
    api.seedCall({
      id: "c-1",
      topic: "the D1 flake",
      initiator: "head",
      members: ["head", "engineering-manager", "e-4f2a"],
      open: true,
      createdAt: NOW.getTime() - 600_000,
      utterances: [
        {
          seq: 1,
          author: "head",
          text: "why is CI red on main?",
          at: NOW.getTime() - 540_000,
        },
        {
          seq: 2,
          author: "e-4f2a",
          text: "a fencepost in the retry loop — fix incoming",
          at: NOW.getTime() - 480_000,
        },
      ],
    });
    await openApp(page, "/?call=c-1");

    await expect(page.getByText("the D1 flake")).toBeVisible();
    await expect(page.getByText("why is CI red on main?")).toBeVisible();
    await expect(
      page.getByText("a fencepost in the retry loop — fix incoming"),
    ).toBeVisible();

    // join: the POST lands in the record and the pushed view renders
    await page
      .getByPlaceholder(/Say something/)
      .fill("try a longer backoff while the fix bakes");
    await page.getByRole("button", { name: "send into the call" }).click();
    await expect
      .poll(() => api.callPosts)
      .toEqual([{ id: "c-1", text: "try a longer backoff while the fix bakes" }]);
    await expect(
      page.getByText("try a longer backoff while the fix bakes"),
    ).toBeVisible();
  });
});

/** The left pane — the valve lives HERE now (the `?triage` deep link
 *  survives, but the HUD shows the queue without a click). */
const inbound = (page: import("@playwright/test").Page) =>
  page.locator("aside[aria-label='Inbound']");

test.describe("the triage valve (the Inbound pane)", () => {
  test("the pane counts and lists the held", async ({ page, api }) => {
    api.seedHeld({ kind: "issue", ref: "acme/app#42", text: "login breaks on Safari" });
    api.seedHeld({ kind: "pull", ref: "acme/app#43", text: "fix: retry backoff fencepost" });
    await openApp(page);

    const pane = inbound(page);
    await expect(pane).toBeVisible();
    await expect(pane).toContainText("2 inbound held");
    await expect(pane.getByText("login breaks on Safari")).toBeVisible();
    await expect(
      pane.getByText("fix: retry backoff fencepost"),
    ).toBeVisible();
  });

  test("releasing one item posts its seq and the row leaves", async ({
    page,
    api,
  }) => {
    const first = api.seedHeld({ text: "login breaks on Safari" });
    api.seedHeld({ text: "fix: retry backoff fencepost" });
    await openApp(page);

    const pane = inbound(page);
    await expect(pane.locator(`[data-held='${first.seq}']`)).toBeVisible();
    await pane
      .getByRole("button", { name: `release inbound ${first.seq}` })
      .click();

    await expect.poll(() => api.triage.released).toEqual([[first.seq]]);
    // the panel reloads right after the POST — the row is gone, the
    // other stays held
    await expect(pane.locator(`[data-held='${first.seq}']`)).toHaveCount(0);
    await expect(
      pane.getByText("fix: retry backoff fencepost"),
    ).toBeVisible();
  });

  test("release all posts without seqs and empties the list", async ({
    page,
    api,
  }) => {
    api.seedHeld({ text: "login breaks on Safari" });
    api.seedHeld({ text: "fix: retry backoff fencepost" });
    await openApp(page);

    const pane = inbound(page);
    await expect(pane.getByText("login breaks on Safari")).toBeVisible();
    await pane.getByRole("button", { name: "release all" }).click();

    await expect.poll(() => api.triage.released).toEqual(["all"]);
    await expect(pane.locator("[data-held]")).toHaveCount(0);
    await expect(
      pane.getByText("The queue is empty — the world is quiet."),
    ).toBeVisible();
  });

  test("the mode toggle PUTs the new mode", async ({ page, api }) => {
    await openApp(page);

    const pane = inbound(page);
    await pane.getByRole("button", { name: "auto mode" }).click();
    await expect.poll(() => api.triage.modeSets).toEqual(["auto"]);
    expect(api.triage.mode).toBe("auto");
    // the panel reloads and shows the flipped valve on its empty state
    await expect(
      pane.getByText("(auto: releases flow through)"),
    ).toBeVisible();
  });
});

const engineering = (page: import("@playwright/test").Page) =>
  page.locator("aside[aria-label='Engineering']");

test.describe("the engineering pane", () => {
  test("shows the manager's feed and the ledger, chips open overlays", async ({
    page,
    api,
  }) => {
    api.seedTurn(
      MANAGER_CHAT,
      "inbound: acme/app#42",
      "Filed as t-1 and assigned.",
    );
    api.seedTask({
      id: "t-1",
      title: "fix Safari login",
      status: "working",
      assignee: "e-1",
      workspace: "pr-9",
      items: [{ ref: "acme/app#42", kind: "issue" }],
    });
    await openApp(page);

    const pane = engineering(page);
    await expect(pane).toBeVisible();
    // the manager's live feed — its own transcript, read-only
    await expect(
      pane.getByText("Filed as t-1 and assigned."),
    ).toBeVisible();
    // the ledger, grouped with status counts
    await expect(pane.locator("[data-pane='tasks']")).toContainText(
      "working 1",
    );
    const task = pane.locator("[data-task='t-1']");
    await expect(task).toBeVisible();
    await expect(task).toContainText("fix Safari login");

    // the workspace chip dials the workspace's terminal
    await task.getByRole("button", { name: "pr-9" }).click();
    await expect(page).toHaveURL("/?workspace=pr-9");
    await expect.poll(() => api.terminal.opened.length).toBe(1);
    expect(decodeURIComponent(api.terminal.sockets[0]!)).toContain(
      "/terminal/Workspace/root::ws-pr-9",
    );

    // …and the assignee chip opens the engineer's session
    await page.getByRole("button", { name: "close overlay" }).click();
    await task.getByRole("button", { name: "e-1" }).click();
    await expect(page).toHaveURL(
      `/?agent=${encodeURIComponent("Engineer:root::e-1")}`,
    );
    await expect(page.getByText("Engineer:root::e-1")).toBeVisible();
  });

  test("approving a pending proposal posts the decision and the row leaves", async ({
    page,
    api,
  }) => {
    api.seedProposal({
      id: "p-1",
      kind: "merge",
      summary: "merge acme/app#43",
      detail: "CI green, review approved — merge the backoff fix.",
    });
    await openApp(page);

    const pane = engineering(page);
    const row = pane.locator("[data-proposal='p-1']");
    await expect(row).toBeVisible();
    await expect(row).toContainText("merge acme/app#43");

    await pane
      .getByRole("button", { name: "approve merge acme/app#43" })
      .click();
    await expect
      .poll(() => api.decisions)
      .toEqual([{ id: "p-1", decision: "approve" }]);
    // the pane reloads ?status=pending — the executed row is gone
    await expect(row).toHaveCount(0);
    await expect(pane.getByText("Nothing awaits you.")).toBeVisible();
  });

  test("the pane toggles away and back", async ({ page }) => {
    await openApp(page);

    await expect(engineering(page)).toBeVisible();
    const toggle = page.getByRole("button", {
      name: "toggle the engineering pane",
    });
    await toggle.click();
    await expect(engineering(page)).toHaveCount(0);
    await toggle.click();
    await expect(engineering(page)).toBeVisible();
  });
});

test.describe("overlays close back to the channel", () => {
  test("the close button returns to /", async ({ page }) => {
    await openApp(page, "/?workspace=pr-9");
    await page.getByRole("button", { name: "close overlay" }).click();
    await expect(page).toHaveURL("/");
  });
});
