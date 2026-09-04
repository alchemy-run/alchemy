/**
 * The REVIEW activity: a pull request is a session — its overview,
 * the bot's review, engineer threads and terminals all share one tab
 * strip and one machine, and opening any of the last three pulls the
 * PR head onto that machine first.
 */
import {
  type FakeApi,
  REPO,
  encodeHash,
  expect,
  main,
  openApp,
  routedTo,
  sidebar,
  tab,
  tabStrip,
  test,
} from "./harness.ts";

const PR = `${REPO}#148`;

const openReview = async (page: Parameters<typeof openApp>[0]) => {
  await openApp(page);
  await page.getByRole("button", { name: /^Review/ }).click();
};

test.describe("pull request board", () => {
  test("lists open pull requests, newest first", async ({ page, api }) => {
    await openReview(page);
    await expect(sidebar(page)).toMatchAriaSnapshot({ name: "board.aria.yml" });
    expect(api.checkouts).toEqual([]);
  });

  test("the activity tab counts open pull requests", async ({ page }) => {
    await openApp(page);
    await expect(
      page.getByRole("button", { name: "Review (2)" }),
    ).toBeVisible();
  });
});

test.describe("overview", () => {
  test("clicking a pull request opens its overview", async ({ page, api }) => {
    await openReview(page);
    await page.getByRole("button", { name: /Add sumToN helper/ }).click();

    await expect(page).toHaveURL(routedTo(`pr:${PR}`));
    await expect(main(page).getByRole("heading", { level: 1 })).toContainText(
      "Add sumToN helper",
    );
    // description, an issue comment, a review with an inline comment,
    // an approval — the whole conversation, in order
    await expect(main(page)).toMatchAriaSnapshot({ name: "overview.aria.yml" });
    // just LOOKING never touches the machine
    expect(api.checkouts).toEqual([]);
  });

  test("the tab strip leads with the overview", async ({ page }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await expect(tab(page, "Pull request")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(tabStrip(page).getByRole("tab")).toHaveCount(1);
  });

  test("the review tab appears once the bot has a session", async ({
    page,
    api,
  }) => {
    api.seedChat(`Reviewer:${PR}`, "running");
    api.board.prs[0]!.session = { id: `Reviewer:${PR}`, status: "running" };
    await openApp(page, encodeHash(`pr:${PR}`));
    await expect(tab(page, "Review")).toBeVisible();
    await tab(page, "Review").click();
    await expect(page).toHaveURL(/Reviewer%3A/);
    await expect(tab(page, "Review")).toHaveAttribute("aria-selected", "true");
  });

  test("request review is disabled while the bot is offline", async ({
    page,
    api,
  }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    const button = main(page).getByRole("button", { name: /request review/ });
    await button.click();
    await expect(button).toBeDisabled();
    expect(api.reviewsRequested).toEqual([148]);
  });

  test("request review opens the bot's session when it comes back", async ({
    page,
    api,
  }) => {
    api.reviewBotOnline = true;
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page)
      .getByRole("button", { name: /request review/ })
      .click();
    await expect(page).toHaveURL(/Reviewer%3A/, { timeout: 15_000 });
    await expect(tab(page, "Review")).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("the machine", () => {
  test("a new thread pulls the PR head first and is the PR's main thread", async ({
    page,
    api,
  }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "thread" }).click();

    await expect(page).toHaveURL(routedTo(`Engineer:${PR}`));
    expect(api.checkouts).toEqual([148]);
    expect(api.opened).toEqual([`Engineer:${PR}`]);
    await expect(tab(page, "main")).toHaveAttribute("aria-selected", "true");
    await expect(main(page)).toContainText("on flow-test-deploy");
  });

  test("a second thread is a sibling on the same machine", async ({
    page,
    api,
  }) => {
    api.seedChat(`Engineer:${PR}`);
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "thread" }).click();
    expect(api.opened).toHaveLength(1);
    expect(api.opened[0]).toMatch(
      /^Engineer:alchemy-run\/test-alchemy#148::t-/,
    );
    await expect(tabStrip(page).getByRole("tab")).toHaveCount(3);
  });

  test("a new terminal pulls the PR head, then opens a shell", async ({
    page,
    api,
  }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "terminal" }).click();

    expect(api.checkouts).toEqual([148]);
    await expect(tab(page, />_\s*1/)).toHaveAttribute("aria-selected", "true");
    await expect(main(page)).toContainText(
      "connected — the session's machine, a real shell",
    );
    expect(api.terminal.opened).toEqual(["main"]);

    // keystrokes reach the PTY
    await page.keyboard.type("ls");
    await expect.poll(() => api.terminal.typed.main).toBe("ls");
  });

  test("re-selecting an open terminal never re-pulls", async ({
    page,
    api,
  }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "terminal" }).click();
    await tab(page, "Pull request").click();
    await tab(page, />_\s*1/).click();
    expect(api.checkouts).toEqual([148]);
  });

  test("pull re-fetches the head on demand", async ({ page, api }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "pull" }).click();
    await expect(main(page)).toContainText("on flow-test-deploy @ 7d7584e");
    expect(api.checkouts).toEqual([148]);
  });
});

test.describe("layout memory", () => {
  test("a reload lands on the PR's last tab with its terminals intact", async ({
    page,
    api,
  }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "thread" }).click();
    await main(page).getByRole("button", { name: "+" }).click();
    await page.getByRole("menuitem", { name: "New terminal" }).click();
    await expect(tab(page, />_\s*1/)).toHaveAttribute("aria-selected", "true");

    await page.reload({ waitUntil: "networkidle" });
    await expect(tab(page, />_\s*1/)).toHaveAttribute("aria-selected", "true");
    await expect(tabStrip(page)).toMatchAriaSnapshot({
      name: "strip-after-reload.aria.yml",
    });
    // a reload re-attaches to the SAME shell — no fresh pull
    expect(api.checkouts).toEqual([148]);
  });

  test("the sidebar counts a PR's threads and terminals", async ({ page }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "thread" }).click();
    await main(page).getByRole("button", { name: "+" }).click();
    await page.getByRole("menuitem", { name: "New terminal" }).click();
    await expect(
      sidebar(page).getByRole("button", { name: /Add sumToN helper/ }),
    ).toMatchAriaSnapshot({ name: "pr-row-with-counts.aria.yml" });
  });

  test("closing the last thread returns to the overview", async ({
    page,
    api,
  }) => {
    await openApp(page, encodeHash(`pr:${PR}`));
    await main(page).getByRole("button", { name: "thread" }).click();
    await tab(page, "main").click({ button: "right" });
    await page.getByRole("menuitem", { name: "Delete thread" }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete thread" })
      .click();
    await expect(tab(page, "Pull request")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(api.deleted).toEqual([`Engineer:${PR}`]);
  });
});

test.describe("activities stay apart", () => {
  test("PR sessions never show up under Code", async ({ page, api }) => {
    api.seedChat(`Engineer:${PR}`);
    api.seedChat(`Engineer:${REPO}/s-alpha`);
    await openApp(page);
    await expect(sidebar(page)).toContainText("s-alpha");
    await expect(sidebar(page)).not.toContainText("#148");
  });

  test("the PR's context menu offers the same verbs as its tab strip", async ({
    page,
  }) => {
    await openReview(page);
    await sidebar(page)
      .getByRole("button", { name: /Add sumToN helper/ })
      .click({ button: "right" });
    await expect(page.getByRole("menu")).toMatchAriaSnapshot({
      name: "pr-context-menu.aria.yml",
    });
  });
});

/** The bot never writes to GitHub: a review, comment, or merge it
 *  produces is a PROPOSAL, and the click that lands it is here. */
test.describe("proposals", () => {
  const seedReview = (api: FakeApi) =>
    api.seedProposal(
      148,
      {
        kind: "review",
        number: 148,
        verdict: "request_changes",
        body: "The helper is right but the test never exercises `n = 0`.",
        comments: [
          {
            path: "src/sum.ts",
            line: 4,
            body: "`Array.from({ length: n })` allocates — a closed form is O(1).",
          },
        ],
      },
      "request changes on #148 (1 inline comment)",
    );

  test("a pending proposal shows in the inbox and on its pull request", async ({
    page,
    api,
  }) => {
    seedReview(api);
    await openApp(page);
    // anywhere in the app: the inbox, bottom right
    const inbox = page.getByLabel("proposals", { exact: true });
    await expect(inbox).toContainText("request changes on #148");
    await expect(inbox).toMatchAriaSnapshot({ name: "inbox-pending.aria.yml" });
    // on the pull request itself: in place, and the inbox steps aside
    await openApp(page, encodeHash(`pr:${PR}`));
    await expect(
      main(page).getByLabel("proposals on this pull request"),
    ).toMatchAriaSnapshot({ name: "pr-proposal-pending.aria.yml" });
    await expect(inbox).toHaveCount(0);
    // seeing a proposal is not acting on it
    expect(api.resolved).toEqual([]);
  });

  test("accepting posts it — the card records where it landed", async ({
    page,
    api,
  }) => {
    const proposal = seedReview(api);
    await openApp(page, encodeHash(`pr:${PR}`));
    const card = main(page).locator(`[data-proposal="${proposal.id}"]`);
    await card.getByRole("button", { name: "post review" }).click();
    await expect(card).toHaveAttribute("data-status", "accepted");
    await expect(card).toContainText(`${REPO}/pull/148`);
    expect(api.resolved).toEqual([{ id: proposal.id, verb: "accept" }]);
  });

  test("declining takes a reason the agent will read", async ({
    page,
    api,
  }) => {
    const proposal = seedReview(api);
    await openApp(page, encodeHash(`pr:${PR}`));
    const card = main(page).locator(`[data-proposal="${proposal.id}"]`);
    await card.getByRole("button", { name: "decline" }).click();
    await card
      .getByLabel("reason for declining")
      .fill("n = 0 is covered by the property test");
    await card.getByRole("button", { name: "confirm decline" }).click();
    await expect(card).toHaveAttribute("data-status", "rejected");
    await expect(card).toContainText("n = 0 is covered");
    expect(api.resolved).toEqual([
      {
        id: proposal.id,
        verb: "reject",
        reason: "n = 0 is covered by the property test",
      },
    ]);
  });

  test("asking for changes keeps it pending — the agent revises it in place", async ({
    page,
    api,
  }) => {
    const proposal = seedReview(api);
    await openApp(page, encodeHash(`pr:${PR}`));
    const card = main(page).locator(`[data-proposal="${proposal.id}"]`);
    await card.getByRole("button", { name: "ask for changes" }).click();
    await card
      .getByLabel("requested changes")
      .fill("drop the allocation nit; check the n = 0 test actually asserts");
    await card.getByRole("button", { name: "send to agent" }).click();
    // still awaiting the operator — the loop iterates, nothing resolved
    await expect(card).toHaveAttribute("data-status", "pending");
    expect(api.resolved).toEqual([
      {
        id: proposal.id,
        verb: "revise",
        message:
          "drop the allocation nit; check the n = 0 test actually asserts",
      },
    ]);
    // the agent's revision lands on the next poll: same card, marked
    await expect(card).toContainText("(revised)", { timeout: 10_000 });
    await expect(card).toContainText("revised");
    await expect(card.getByRole("button", { name: "post review" })).toBeVisible();
  });

  test("the inbox card jumps to the proposing session", async ({
    page,
    api,
  }) => {
    seedReview(api);
    api.seedChat(`Reviewer:${PR}`, "idle");
    api.board.prs[0]!.session = { id: `Reviewer:${PR}`, status: "idle" };
    await openApp(page);
    await page
      .getByLabel("proposals", { exact: true })
      .getByRole("button", { name: `Reviewer:${PR}` })
      .click();
    await expect(page).toHaveURL(routedTo(`Reviewer:${PR}`));
  });
});

test.describe("transcript", () => {
  test("a command's ANSI colors render as color, not escape codes", async ({
    page,
    api,
  }) => {
    api.seedBash(`Engineer:${REPO}/s-alpha`, {
      ask: "run the build",
      command: "pnpm build",
      stdout: "\u001b[32m✓\u001b[39m built in \u001b[1m1.42s\u001b[22m\n\u001b[K",
      reply: "Built.",
    });
    await openApp(page, encodeHash(`Engineer:${REPO}/s-alpha`));
    const card = main(page).getByRole("button", { name: /pnpm build/ });
    // collapsed: the summary line is the verdict, escape-free
    await expect(main(page)).toContainText("✓ built in 1.42s");
    await card.click();
    const body = main(page).locator("pre").filter({ hasText: "built in" });
    await expect(body).not.toContainText("[32m");
    await expect(body.locator("span").filter({ hasText: "✓" })).toHaveCSS(
      "color",
      /rgb\(/,
    );
  });
});
