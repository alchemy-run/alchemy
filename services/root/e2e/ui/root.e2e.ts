/**
 * The ONE page and its overlays, against the fake backend
 * (`harness.ts`): the Root channel renders the Head's session and
 * posts into it; an `ask` tool card opens into its nested chain; the
 * `?workspace=` overlay dials the workspace's terminal socket; the
 * `?call=` overlay streams a call's thread and lets the human join;
 * closing any overlay returns to `/`.
 */
import { expect, test, openApp, NOW, ROOT_CHAT } from "./harness";

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

test.describe("overlays close back to the channel", () => {
  test("the close button returns to /", async ({ page }) => {
    await openApp(page, "/?workspace=pr-9");
    await page.getByRole("button", { name: "close overlay" }).click();
    await expect(page).toHaveURL("/");
  });
});
