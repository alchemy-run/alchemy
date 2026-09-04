/**
 * The REVIEW activity: a pull request is a session — its overview,
 * the bot's review, engineer threads and terminals all share one tab
 * strip and one machine, and opening any of the last three pulls the
 * PR head onto that machine first.
 */
import {
  type FakeApi,
  REPO,
  pathOf,
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

/** The header's bell — its name carries the pending count. */
const bell = (page: Parameters<typeof openApp>[0]) =>
  page.getByRole("banner").getByRole("button", { name: /^notifications/ });

/** Open the bell's popover: the inbox. */
const openInbox = async (page: Parameters<typeof openApp>[0]) => {
  await bell(page).click();
  const inbox = page.getByRole("dialog", { name: "proposals" });
  await expect(inbox).toBeVisible();
  return inbox;
};

test.describe("pull request board", () => {
  test("lists open pull requests, newest first", async ({ page, api }) => {
    await openReview(page);
    await expect(sidebar(page)).toMatchAriaSnapshot({ name: "board.aria.yml" });
    expect(api.checkouts).toEqual([]);
  });

  test("the Review activity counts open pull requests", async ({ page }) => {
    await openApp(page);
    await expect(
      page.getByRole("navigation", { name: "Activities" }).getByRole("button", {
        name: "Review 2",
      }),
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
    // every author is a link to their GitHub profile
    await expect(
      main(page).getByRole("link", { name: "sam-goodwin" }).first(),
    ).toHaveAttribute("href", "https://github.com/sam-goodwin");
    // just LOOKING never touches the machine
    expect(api.checkouts).toEqual([]);
  });

  test("every code block in the markdown copies itself", async ({ page }) => {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    // PR 147's review carries a fenced ```typescript block
    await openApp(page, pathOf(`pr:alchemy-run/test-alchemy#147`));
    const copy = main(page).getByRole("button", { name: "Copy code" });
    await expect(copy).toHaveCount(2);
    const first = copy.first();
    // hidden until the block is hovered
    await expect(first).toHaveCSS("opacity", "0");
    await first.hover();
    await expect(first).toHaveCSS("opacity", "1");
    await first.click();
    // the button says so, and the clipboard holds the block, verbatim
    await expect(
      main(page).getByRole("button", { name: "Copied" }),
    ).toHaveCount(1);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "for (let index = 0; index < values.length; index += size) {",
    );
  });

  test("the tab strip leads with the overview", async ({ page }) => {
    await openApp(page, pathOf(`pr:${PR}`));
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
    await openApp(page, pathOf(`pr:${PR}`));
    await expect(tab(page, "Review")).toBeVisible();
    await tab(page, "Review").click();
    await expect(page).toHaveURL(/\/review$/);
    await expect(tab(page, "Review")).toHaveAttribute("aria-selected", "true");
  });

  test("request review is disabled while the bot is offline", async ({
    page,
    api,
  }) => {
    await openApp(page, pathOf(`pr:${PR}`));
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
    await openApp(page, pathOf(`pr:${PR}`));
    await main(page)
      .getByRole("button", { name: /request review/ })
      .click();
    await expect(page).toHaveURL(/\/review$/, { timeout: 15_000 });
    await expect(tab(page, "Review")).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("files changed", () => {
  const views = (page: Parameters<typeof openApp>[0]) =>
    main(page).getByRole("tablist", { name: "pull request views" });
  const filesTab = (page: Parameters<typeof openApp>[0]) =>
    views(page).getByRole("tab", { name: /Files changed/ });
  const files = (page: Parameters<typeof openApp>[0]) =>
    main(page).getByLabel("files changed");
  const card = (page: Parameters<typeof openApp>[0], file: string) =>
    files(page).locator(`[data-changed-file="${file}"]`);

  test("the diff renders file by file, with the review's comments on their lines", async ({
    page,
  }) => {
    await openApp(page, pathOf(`pr:alchemy-run/test-alchemy#147`));
    // the tabs count what they hold
    await expect(
      views(page).getByRole("tab", { name: /Conversation/ }),
    ).toContainText("1");
    await expect(filesTab(page)).toContainText("2");
    await filesTab(page).click();
    await expect(page).toHaveURL(/\/pull\/147\/files$/);
    await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
    // the summary: every path with its +/−
    await expect(files(page)).toContainText("2 files changed");
    await expect(
      files(page)
        .getByRole("list", { name: "changed files" })
        .getByRole("listitem"),
    ).toHaveText([
      /src\/arrays\.ts\s*\+14\s*−0/,
      /test\/arrays\.test\.ts\s*\+23\s*−0/,
    ]);
    // one card per file, the code highlighted in it (a shadow root —
    // getByText pierces it)
    await expect(files(page).locator("[data-changed-file]")).toHaveCount(2);
    await expect(
      card(page, "src/arrays.ts").getByText(
        "chunk size must be a positive integer",
      ),
    ).toBeVisible();
    // the review's inline comments sit under the lines they were left on
    await expect(files(page)).toContainText("Critical Bug");
    await expect(files(page)).toContainText("incomplete coverage");
    // the conversation is not shown alongside (kept, hidden — see below)
    await expect(main(page).getByText("opened this pull request")).toBeHidden();
  });

  test("the file list jumps to a file; Conversation brings the thread back", async ({
    page,
  }) => {
    await openApp(page, pathOf(`pr:alchemy-run/test-alchemy#147`));
    await filesTab(page).click();
    // both cards drawn before the jump
    await expect(
      card(page, "test/arrays.test.ts").getByText(
        "should dedupe preserving order",
      ),
    ).toBeAttached();
    await files(page)
      .getByRole("button", { name: /test\/arrays\.test\.ts/ })
      .click();
    await expect(card(page, "test/arrays.test.ts")).toBeInViewport();
    await views(page)
      .getByRole("tab", { name: /Conversation/ })
      .click();
    await expect(page).toHaveURL(/\/pull\/147$/);
    await expect(
      main(page).getByText("opened this pull request"),
    ).toBeVisible();
    await expect(files(page)).toBeHidden();
  });

  test("switching tabs neither refetches nor re-renders the diff, and keeps the place", async ({
    page,
    api,
  }) => {
    await openApp(page, `${pathOf(`pr:alchemy-run/test-alchemy#147`)}/files`);
    const second = card(page, "test/arrays.test.ts");
    await expect(
      second.getByText("should dedupe preserving order"),
    ).toBeAttached();
    const fetched = api.filePages.length;
    // scroll down to the second file and mark its rendered node
    await files(page)
      .getByRole("button", { name: /test\/arrays\.test\.ts/ })
      .click();
    await expect(second).toBeInViewport();
    const scroller = main(page).locator(".overflow-y-auto").first();
    const offset = await scroller.evaluate((node) => node.scrollTop);
    expect(offset).toBeGreaterThan(0);
    await second.evaluate((node) => {
      node.dataset.rendered = "once";
    });
    // the tab strip sticks to the top, so it is reachable from down here
    const proposalsTab = views(page).getByRole("tab", { name: /Proposals/ });
    await expect(proposalsTab).toBeInViewport();
    // away to Proposals (its own top), and back
    await proposalsTab.click();
    await expect(files(page)).toBeHidden();
    expect(await scroller.evaluate((node) => node.scrollTop)).toBe(0);
    await filesTab(page).click();
    await expect(files(page)).toBeVisible();
    // no page was fetched again, the same node is still there, and the
    // reader is where they were
    expect(api.filePages.length).toBe(fetched);
    await expect(second).toHaveAttribute("data-rendered", "once");
    await expect(second).toBeInViewport();
    expect(await scroller.evaluate((node) => node.scrollTop)).toBe(offset);
    await expect(files(page)).not.toContainText("Loading diff");
  });

  test("a push while reading offers a refresh instead of swapping the diff", async ({
    page,
    api,
  }) => {
    await openApp(page, `${pathOf(`pr:alchemy-run/test-alchemy#147`)}/files`);
    await expect(files(page).locator("[data-changed-file]")).toHaveCount(2);
    const fetched = api.filePages.length;
    await expect(files(page).getByRole("status")).toHaveCount(0);
    // a new commit lands; the view notices on its next poll (returning
    // to the window polls at once)
    const view = api.prs[147]!;
    const before = view.head.sha;
    // a copy — the fixture module is shared by every test in the worker
    api.prs[147] = {
      ...view,
      head: { ...view.head, sha: "feedfacefeedfacefeedfacefeedfacefeedface" },
    };
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const bar = files(page).getByRole("status");
    await expect(bar).toContainText("New changes were pushed");
    await expect(bar).toContainText(before.slice(0, 7));
    await expect(bar).toContainText("feedfac");
    // the diff shown did not move
    expect(api.filePages.length).toBe(fetched);
    await expect(files(page).locator("[data-changed-file]")).toHaveCount(2);
    // …until asked
    await bar.getByRole("button", { name: "Refresh" }).click();
    await expect(bar).toHaveCount(0);
    await expect(files(page).locator("[data-changed-file]")).toHaveCount(2);
    expect(api.filePages.length).toBe(fetched + 2);
  });

  test("a big PR streams in page by page — never one 20 000-line fetch", async ({
    page,
    api,
  }) => {
    await openApp(page, `${pathOf(`pr:alchemy-run/test-alchemy#147`)}/files`);
    await expect(files(page).locator("[data-changed-file]")).toHaveCount(2);
    // the fake pages one file at a time: the UI walked both pages,
    // in order, and stopped at `next: null` (the overview mounts
    // twice on open; the first walk is aborted, never doubled)
    expect(api.filePages.slice(-2)).toEqual([
      { number: 147, page: 1 },
      { number: 147, page: 2 },
    ]);
    expect(api.filePages.every((row) => row.page <= 2)).toBe(true);
    await expect(files(page)).not.toContainText("loading more");
  });

  test("a file GitHub cannot serve, and one too large to render by default", async ({
    page,
    api,
  }) => {
    api.unrenderable.add("src/arrays.ts");
    api.large.add("test/arrays.test.ts");
    await openApp(page, `${pathOf(`pr:alchemy-run/test-alchemy#147`)}/files`);
    // no patch → a placeholder with the path, the counts, and the link out
    const unrenderable = card(page, "src/arrays.ts");
    await expect(unrenderable).toContainText(
      "This file's diff is too large for GitHub to serve.",
    );
    await expect(
      unrenderable.getByRole("link", { name: /View file/ }),
    ).toHaveAttribute("href", /blob\/head\/src\/arrays\.ts$/);
    await expect(
      unrenderable.getByText("chunk size must be a positive integer"),
    ).toHaveCount(0);
    // a huge file waits for a click — its code is not in the DOM yet
    const large = card(page, "test/arrays.test.ts");
    await expect(large).toContainText("Large diff not rendered by default.");
    await expect(large).toContainText("+1,200");
    await expect(large.getByText("should dedupe preserving order")).toHaveCount(
      0,
    );
    await large.getByRole("button", { name: "Load diff" }).click();
    await expect(
      large.getByText("should dedupe preserving order"),
    ).toBeAttached();
  });

  test("the /files path lands on the tab — a reload keeps it", async ({
    page,
  }) => {
    await openApp(page, `${pathOf(`pr:${PR}`)}/files`);
    await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(files(page)).toContainText("1 file changed");
    await page.reload();
    await expect(filesTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/pull\/148\/files$/);
  });
});

test.describe("the machine", () => {
  test("a new thread pulls the PR head first and is the PR's main thread", async ({
    page,
    api,
  }) => {
    await openApp(page, pathOf(`pr:${PR}`));
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
    await openApp(page, pathOf(`pr:${PR}`));
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
    await openApp(page, pathOf(`pr:${PR}`));
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
    await openApp(page, pathOf(`pr:${PR}`));
    await main(page).getByRole("button", { name: "terminal" }).click();
    await tab(page, "Pull request").click();
    await tab(page, />_\s*1/).click();
    expect(api.checkouts).toEqual([148]);
  });

  test("pull re-fetches the head on demand", async ({ page, api }) => {
    await openApp(page, pathOf(`pr:${PR}`));
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
    await openApp(page, pathOf(`pr:${PR}`));
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
    await openApp(page, pathOf(`pr:${PR}`));
    await main(page).getByRole("button", { name: "thread" }).click();
    await main(page).getByRole("button", { name: "+" }).click();
    await page.getByRole("menuitem", { name: "New terminal" }).click();
    await expect(
      sidebar(page).getByRole("button", { name: /Add sumToN helper/ }),
    ).toMatchAriaSnapshot({ name: "pr-row-with-counts.aria.yml" });
  });

  test("long titles truncate to one line — the full title is a hover away", async ({
    page,
    api,
  }) => {
    const long =
      "feat(cli): standardize auth provider management across every cloud provider";
    api.board.prs = [
      { number: 1480, title: long, state: "open", updatedAt: 0 },
      ...api.board.prs,
    ];
    await openApp(page, "/pulls");
    const list = sidebar(page).locator(".overflow-y-auto");
    // the list never scrolls sideways, however long the title
    expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(
      0,
    );
    const row = sidebar(page).getByRole("button", { name: /standardize auth/ });
    expect(
      await row.boundingBox().then((box) => box?.height ?? 0),
    ).toBeLessThan(36);
    // a title that fits stays quiet…
    await sidebar(page).getByText("Add sumToN helper").hover();
    await page.waitForTimeout(600);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    // …a clipped one reveals itself in full
    await row.getByText(/standardize auth/).hover();
    await expect(page.getByRole("tooltip")).toHaveText(long);
  });

  test("closing the last thread returns to the overview", async ({
    page,
    api,
  }) => {
    await openApp(page, pathOf(`pr:${PR}`));
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
    // anywhere in the app: the bell counts it, its popover lists it
    await expect(bell(page)).toHaveAccessibleName(
      "notifications, 1 awaiting you",
    );
    const inbox = await openInbox(page);
    await expect(inbox).toContainText("request changes on #148");
    await expect(inbox).toMatchAriaSnapshot({ name: "inbox-pending.aria.yml" });
    // on the pull request itself: its Proposals tab counts it and holds
    // it in full — and the bell keeps counting it (the list never
    // changes under the operator)
    await openApp(page, pathOf(`pr:${PR}`));
    const proposalsTab = main(page).getByRole("tab", { name: /Proposals/ });
    await expect(proposalsTab).toContainText("1");
    await proposalsTab.click();
    await expect(page).toHaveURL(/\/pull\/148\/proposals$/);
    await expect(
      main(page).getByLabel("proposals on this pull request"),
    ).toMatchAriaSnapshot({ name: "pr-proposal-pending.aria.yml" });
    await expect(bell(page)).toHaveAccessibleName(
      "notifications, 1 awaiting you",
    );
    await expect(await openInbox(page)).toContainText(
      "request changes on #148",
    );
    // seeing a proposal is not acting on it
    expect(api.resolved).toEqual([]);
  });

  test("accepting posts it — the card records where it landed", async ({
    page,
    api,
  }) => {
    const proposal = seedReview(api);
    await openApp(page, `${pathOf(`pr:${PR}`)}/proposals`);
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
    await openApp(page, `${pathOf(`pr:${PR}`)}/proposals`);
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
    await openApp(page, `${pathOf(`pr:${PR}`)}/proposals`);
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
    await expect(
      card.getByRole("button", { name: "post review" }),
    ).toBeVisible();
  });

  test("the inbox is one line per proposal — the chevron opens the card", async ({
    page,
    api,
  }) => {
    seedReview(api);
    api.seedChat(`Reviewer:${PR}`, "idle");
    api.board.prs[0]!.session = { id: `Reviewer:${PR}`, status: "idle" };
    await openApp(page);
    const inbox = await openInbox(page);
    const details = inbox.getByRole("button", { name: "details" });
    // folded: the agent's one-line summary and the status, nothing else
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await expect(
      inbox.getByRole("button", { name: "post review" }),
    ).toHaveCount(0);
    // open: the card with its buttons and its links
    await details.click();
    await expect(
      inbox.getByRole("button", { name: "collapse" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      inbox.getByRole("button", { name: "post review" }),
    ).toBeVisible();
    await expect(inbox.getByRole("link", { name: "github ↗" })).toHaveAttribute(
      "href",
      `https://github.com/${REPO}/pull/148`,
    );
    // the chevron folds it back
    await inbox.getByRole("button", { name: "collapse" }).click();
    await expect(
      inbox.getByRole("button", { name: "post review" }),
    ).toHaveCount(0);
    // the card jumps to the proposing session — and the popover closes
    await details.click();
    await inbox.getByRole("button", { name: `Reviewer:${PR}` }).click();
    await expect(page).toHaveURL(routedTo(`Reviewer:${PR}`));
    await expect(inbox).toHaveCount(0);
  });

  test("the line itself jumps to the pull request — no expanding needed", async ({
    page,
    api,
  }) => {
    seedReview(api);
    await openApp(page);
    const inbox = await openInbox(page);
    const line = inbox.getByRole("link", { name: "request changes on #148" });
    // a real link — the PR's Proposals tab, so it can be copied or
    // opened aside
    await expect(line).toHaveAttribute(
      "href",
      `${pathOf(`pr:${PR}`)}/proposals`,
    );
    await line.click();
    // landed on the pull request's Proposals tab, the proposal in full
    await expect(page).toHaveURL(/\/pull\/148\/proposals$/);
    await expect(
      main(page).getByRole("tab", { name: /Proposals/ }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      main(page).getByLabel("proposals on this pull request"),
    ).toContainText("request changes on #148");
    await expect(inbox).toHaveCount(0);
  });

  test("the inbox is a stack by last activity — a revision lifts a proposal", async ({
    page,
    api,
  }) => {
    const older = api.seedProposal(
      147,
      { kind: "comment", number: 147, body: "Consider chunking lazily." },
      "comment on #147",
    );
    const newer = seedReview(api);
    // the newer one was made later …
    newer.at = older.at + 10_000;
    await openApp(page);
    const inbox = await openInbox(page);
    const lines = inbox.getByRole("link");
    await expect(lines).toHaveText([
      /request changes on #148/,
      /comment on #147/,
    ]);
    // … but a revision on the older one is the LATEST activity
    older.revisedAt = newer.at + 10_000;
    await expect(lines).toHaveText([
      /comment on #147/,
      /request changes on #148/,
    ]);
    // jumping to one changes nothing about the list
    await lines.first().click();
    await expect(page).toHaveURL(/\/pull\/147\/proposals$/);
    await openInbox(page);
    await expect(lines).toHaveText([
      /comment on #147/,
      /request changes on #148/,
    ]);
  });

  test("the bell shows the exact count, never an abbreviation", async ({
    page,
    api,
  }) => {
    for (let i = 0; i < 12; i++) {
      api.seedProposal(
        147,
        { kind: "comment", number: 147, body: `note ${i}` },
        `comment ${i} on #147`,
      );
    }
    await openApp(page);
    await expect(bell(page)).toHaveAccessibleName(
      "notifications, 12 awaiting you",
    );
    await expect(bell(page)).toHaveText("12");
  });

  test("the bell is quiet when nothing is pending", async ({ page }) => {
    await openApp(page);
    await expect(bell(page)).toHaveAccessibleName("notifications");
    const inbox = await openInbox(page);
    await expect(inbox).toContainText("Nothing awaiting you.");
  });
});

test.describe("header", () => {
  test("the operator's avatar menu names the GitHub account", async ({
    page,
  }) => {
    await openApp(page);
    await page
      .getByRole("banner")
      .getByRole("button", { name: "account, sam-goodwin" })
      .click();
    const menu = page.getByRole("menu");
    await expect(menu).toContainText("Sam Goodwin");
    await expect(menu).toContainText("@sam-goodwin");
    await expect(
      menu.getByRole("menuitem", { name: "GitHub profile" }),
    ).toHaveAttribute("href", "https://github.com/sam-goodwin");
  });

  test("the theme follows the system until picked, and the pick sticks", async ({
    page,
  }) => {
    await openApp(page);
    const html = page.locator("html");
    // the harness browser prefers dark: system → dark
    await expect(html).toHaveClass(/dark/);
    // one button, one click: it flips what is showing
    const toggle = page
      .getByRole("banner")
      .getByRole("button", { name: /mode$/ });
    await expect(toggle).toHaveAccessibleName("switch to light mode");
    await toggle.click();
    await expect(html).not.toHaveClass(/dark/);
    await expect(toggle).toHaveAccessibleName("switch to dark mode");
    // remembered across a reload — applied before React mounts
    await page.reload({ waitUntil: "networkidle" });
    await expect(html).not.toHaveClass(/dark/);
    await toggle.click();
    await expect(html).toHaveClass(/dark/);
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
      stdout:
        "\u001b[32m✓\u001b[39m built in \u001b[1m1.42s\u001b[22m\n\u001b[K",
      reply: "Built.",
    });
    await openApp(page, pathOf(`Engineer:${REPO}/s-alpha`));
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
