/**
 * The CHANNEL — the org's one stream: world events as rows, the
 * operator's messages, cards from threads, the sidebar directory,
 * the bell.
 */
import type { Page } from "@playwright/test";
import {
  expect,
  main,
  openApp,
  REPO,
  test,
  threadNav,
  threadPath,
} from "./harness.ts";

test("events, the operator, and the agent render as rows", async ({
  page,
  api,
}) => {
  api.seedEvent(
    `opened issue [${REPO}#12](https://github.com/${REPO}/issues/12) — Bug in reconcile`,
    { author: "octocat", event: "IssueOpened", ref: `${REPO}#12` },
  );
  api.seedUser("triage that issue please");
  api.seedAgent("Placed it on a new thread.");
  await openApp(page);

  await expect(main(page)).toContainText("octocat");
  await expect(main(page)).toContainText("Bug in reconcile");
  await expect(main(page)).toContainText("triage that issue please");
  await expect(main(page)).toContainText("Placed it on a new thread.");
});

test("the composer posts to the channel and the echo lands live", async ({
  page,
  api,
}) => {
  await openApp(page);
  const composer = page.getByRole("textbox", { name: "Message the channel" });
  await composer.fill("hello channel");
  await composer.press("Enter");

  await expect.poll(() => api.posts).toEqual(["hello channel"]);
  // the fake pushes the user row over the live socket
  await expect(main(page)).toContainText("hello channel");
});

test("the run pill opens the run rail; the eval card shows code and output", async ({
  page,
  api,
}) => {
  const asked = api.seedUser("triage this please");
  // the run's session: one codemode eval — the program, its result,
  // and what it logged
  api.seedTool(`Channel:main@${asked.seq}`, {
    ask: "triage this please",
    name: "eval",
    input: {
      code: 'const hits = await search_messages({ q: "reconcile" });\nexport default hits;',
    },
    output: '{ "total": 3 }\n\n--- logs ---\nsearching the stream…',
    reply: "Looked at the stream — placing it on a thread.",
  });
  await openApp(page);

  // in flight: no agent reply after the message yet
  const pill = main(page).getByRole("button", { name: /working/ });
  await expect(pill).toBeVisible();

  // the pill opens the run's own session in the right-hand rail — the
  // exploration lives there, not in the channel stream
  await pill.click();
  const rail = page.getByRole("complementary", { name: "Run" });

  // the eval card: the program syntax-highlighted, the result, the logs
  await expect(rail).toContainText("Run code");
  await expect(rail).toContainText("search_messages");
  await expect(rail).toContainText('"total": 3');
  await expect(rail).toContainText("searching the stream…");

  // the run's FINAL reply belongs to the channel, not the rail
  await expect(rail).not.toContainText(
    "Looked at the stream — placing it on a thread.",
  );

  // the reply lands → the pill settles to "ran"
  api.pushMessage({ kind: "agent", text: "Placed it on w-triage." });
  await expect(
    main(page).getByRole("button", { name: /^ran$/ }),
  ).toBeVisible();

  // the rail closes on demand
  await rail.getByRole("button", { name: "Close the run pane" }).click();
  await expect(rail).toBeHidden();
});

/** The stream row holding `text`. */
const rowOf = (page: Page, text: string) =>
  main(page).locator("[data-seq]", { hasText: text }).first();

test("right-click a message: Delete asks, then drops the row live", async ({
  page,
  api,
}) => {
  api.seedEvent("opened issue — Bug in reconcile", { author: "octocat" });
  const doomed = api.seedUser("delete me please");
  api.seedAgent("Noted.");
  await openApp(page);
  await expect(main(page)).toContainText("delete me please");

  // the menu opens on the row; Delete asks first — a dismissed confirm
  // deletes nothing
  await rowOf(page, "delete me please").click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(() => api.deletedMessages).toEqual([]);
  await expect(main(page)).toContainText("delete me please");

  // confirmed: the DELETE lands and the socket's remove frame drops
  // the row from the view
  await rowOf(page, "delete me please").click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect.poll(() => api.deletedMessages).toEqual([doomed.id]);
  await expect(main(page)).not.toContainText("delete me please");
  // the neighbors survive
  await expect(main(page)).toContainText("Bug in reconcile");
  await expect(main(page)).toContainText("Noted.");
});

test("right-click on a link is the browser's — our menu stays shut", async ({
  page,
  api,
}) => {
  api.seedEvent(
    `opened issue [${REPO}#12](https://github.com/${REPO}/issues/12) — Bug in reconcile`,
    { author: "octocat", ref: `${REPO}#12` },
  );
  await openApp(page);
  const link = main(page).getByRole("link", { name: `${REPO}#12` });
  await expect(link).toBeVisible();

  // on the link: no menu of ours (the native link menu is the browser's
  // to draw), and the row is not selected by it either
  await link.click({ button: "right" });
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await expect(main(page).locator("[data-seq][data-selected]")).toHaveCount(0);

  // beside the link, the same row still opens ours
  await main(page).getByText("Bug in reconcile").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
});

test("click, ⇧-click and ⌘-click build a selection; the menu acts on all of it", async ({
  page,
  api,
}) => {
  const one = api.seedEvent("event one", { author: "octocat" });
  const two = api.seedEvent("event two", { author: "octocat" });
  const three = api.seedEvent("event three", { author: "octocat" });
  api.seedEvent("event four", { author: "octocat" });
  const five = api.seedEvent("event five", { author: "octocat" });
  await openApp(page);
  await expect(main(page)).toContainText("event five");

  const selected = main(page).locator("[data-seq][data-selected]");
  // a plain click selects the one row — the anchor
  await main(page).getByText("event one").click();
  await expect(selected).toHaveCount(1);
  // ⇧-click ranges from the anchor
  await main(page).getByText("event three").click({ modifiers: ["Shift"] });
  await expect(selected).toHaveCount(3);

  // right-click inside it, then dismiss the menu — the gesture is over
  // and the selection goes with it
  await rowOf(page, "event two").click({ button: "right" });
  await expect(
    page.getByRole("menuitem", { name: "Delete 3 messages" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await expect(selected).toHaveCount(0);

  // rebuild it: click anchors, ⇧-click ranges
  await main(page).getByText("event one").click();
  await main(page).getByText("event three").click({ modifiers: ["Shift"] });
  await expect(selected).toHaveCount(3);
  // ⌘-click toggles one more in
  await main(page).getByText("event five").click({ modifiers: ["Meta"] });
  await expect(selected).toHaveCount(4);
  // ...and out again
  await main(page).getByText("event five").click({ modifiers: ["Meta"] });
  await expect(selected).toHaveCount(3);
  await main(page).getByText("event five").click({ modifiers: ["Meta"] });

  // right-click INSIDE the selection keeps it — the menu counts it
  await rowOf(page, "event two").click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Delete 4 messages" }).click();
  await expect
    .poll(() => api.deletedMessages)
    .toEqual([one.id, two.id, three.id, five.id]);
  await expect(main(page)).not.toContainText("event one");
  await expect(main(page)).toContainText("event four");

  // ⌘-click toggles one out; Escape clears
  await main(page).getByText("event four").click();
  await expect(selected).toHaveCount(1);
  await main(page).getByText("event four").click({ modifiers: ["Meta"] });
  await expect(selected).toHaveCount(0);
  await main(page).getByText("event four").click();
  await expect(selected).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(selected).toHaveCount(0);

  // right-click on an UNSELECTED row: not selected — TARGETED, lit only
  // while its menu is open, and the menu acts on it alone
  // (CSS, not role-scoped: the open menu is modal, so the rest of the
  // page is aria-hidden and `getByRole("main")` resolves to nothing)
  const targeted = page.locator("main [data-seq][data-targeted]");
  await rowOf(page, "event four").click({ button: "right" });
  await expect(targeted).toHaveCount(1);
  await expect(page.locator("main [data-seq][data-selected]")).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem")).toHaveCount(0);
  await expect(targeted).toHaveCount(0);
});

test("Reply from the menu quotes the original; the post carries replyTo", async ({
  page,
  api,
}) => {
  const original = api.seedEvent("opened issue — Bug in reconcile", {
    author: "octocat",
  });
  api.seedAgent("Noted.");
  await openApp(page);

  // Reply → the composer shows what it will answer and takes focus
  await rowOf(page, "Bug in reconcile").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reply" }).click();
  const bar = main(page).getByLabel("Replying to", { exact: true });
  await expect(bar).toContainText("octocat");
  await expect(bar).toContainText("Bug in reconcile");
  const composer = page.getByRole("textbox", { name: "Message the channel" });
  await expect(composer).toBeFocused();

  // send: the POST names the original; the echoed row quotes it
  await composer.fill("on it — fixing now");
  await composer.press("Enter");
  await expect
    .poll(() => api.replies)
    .toEqual([{ text: "on it — fixing now", replyTo: [original.id] }]);
  await expect(bar).toBeHidden();
  const reply = rowOf(page, "on it — fixing now");
  await expect(reply).toContainText("octocat");
  await expect(
    reply.getByRole("button", { name: /Bug in reconcile/ }),
  ).toBeVisible();
});

test("a live event pushed over the socket appears without a reload", async ({
  page,
  api,
}) => {
  await openApp(page);
  api.pushMessage({
    kind: "event",
    text: "pushed 2 commits",
    repo: REPO,
    event: "Push",
  });
  await expect(main(page)).toContainText("pushed 2 commits");
});

test("an event placed on a thread wears its chip; the chip navigates", async ({
  page,
  api,
}) => {
  api.seedThread({ id: "t-1", name: "w-reconcile", title: "Fix reconcile" });
  api.seedEvent("opened issue #12 — Bug in reconcile", {
    author: "octocat",
    thread: "t-1",
  });
  await openApp(page);

  await main(page).getByRole("button", { name: "w-reconcile" }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
});

test("the sidebar groups open threads by turn and selects on click", async ({
  page,
  api,
}) => {
  api.seedThread({
    id: "t-you",
    name: "w-yours",
    title: "Awaits you",
    turn: "you",
  });
  api.seedThread({
    id: "t-agents",
    name: "w-working",
    title: "Agents at work",
    turn: "agents",
  });
  api.seedThread({
    id: "t-closed",
    name: "w-done",
    title: "Shipped",
    status: "closed",
  });
  await openApp(page);

  const nav = threadNav(page);
  await expect(nav).toMatchAriaSnapshot({ name: "sidebar.aria.yml" });

  // exact: the row's hover trash is also a button named after the thread
  const yours = nav.getByRole("button", { name: "w-yours", exact: true });
  await yours.click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-you")}$`));
  await expect(yours).toHaveAttribute("aria-current", "page");
});

test("right-click a sidebar row: Delete thread asks, then erases it", async ({
  page,
  api,
}) => {
  api.seedThread({ id: "t-old", name: "container-fixes", status: "closed" });
  api.seedThread({ id: "t-live", name: "w-reconcile", turn: "you" });
  await openApp(page);
  const row = threadNav(page).getByRole("button", {
    name: "container-fixes",
    exact: true,
  });
  await expect(row).toBeVisible();

  // dismissed: nothing happens
  await row.click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.dismiss());
  await page.getByRole("menuitem", { name: "Delete thread" }).click();
  await expect.poll(() => api.deletedThreads).toEqual([]);
  await expect(row).toBeVisible();

  // confirmed: the DELETE lands and the directory frame drops the row;
  // the view was on the channel and stays there
  await row.click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Delete thread" }).click();
  await expect.poll(() => api.deletedThreads).toEqual(["t-old"]);
  await expect(threadNav(page)).not.toContainText("container-fixes");
  await expect(threadNav(page)).toContainText("w-reconcile");
  await expect(
    page.getByRole("textbox", { name: "Message the channel" }),
  ).toBeVisible();
});

test("⌘-click selects sidebar rows without opening them; the menu deletes the set", async ({
  page,
  api,
}) => {
  api.seedThread({ id: "t-a", name: "w-alpha", turn: "you" });
  api.seedThread({ id: "t-b", name: "w-beta", turn: "you" });
  api.seedThread({ id: "t-c", name: "w-gamma", status: "closed" });
  await openApp(page);
  const nav = threadNav(page);
  const rowOf = (name: string) =>
    nav.getByRole("button", { name, exact: true });

  await rowOf("w-alpha").click({ modifiers: ["Meta"] });
  await rowOf("w-gamma").click({ modifiers: ["Meta"] });
  // still on the channel — ⌘-click selects, it doesn't open
  await expect(page).toHaveURL(/\/$/);
  await expect(nav.locator("[data-thread][data-selected]")).toHaveCount(2);

  await rowOf("w-gamma").click({ button: "right" });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("menuitem", { name: "Delete 2 threads" }).click();
  await expect
    .poll(() => [...api.deletedThreads].sort())
    .toEqual(["t-a", "t-c"]);
  await expect(nav).not.toContainText("w-alpha");
  await expect(nav).toContainText("w-beta");
});

test("a card from a thread renders and its header jumps to the thread", async ({
  page,
  api,
}) => {
  api.seedThread({ id: "t-1", name: "w-fix", title: "Fix the bug" });
  api.seedCard(
    { thread: "t-1", title: "Pull request opened for #12" },
    "Opened [#14](https://github.com/o/r/pull/14) — CI is running.",
  );
  await openApp(page);

  await expect(main(page)).toContainText("CI is running.");
  await main(page)
    .getByRole("button", { name: /Pull request opened for #12/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
});

test("the bell counts new cards and its list jumps to the thread", async ({
  page,
  api,
}) => {
  api.seedThread({ id: "t-1", name: "w-fix", title: "Fix the bug" });
  api.seedCard(
    { thread: "t-1", title: "Merged #14" },
    "CI was green; squashed.",
  );
  await openApp(page);

  const bell = page.getByRole("button", {
    name: /notifications, 1 new/,
  });
  await expect(bell).toBeVisible();
  await bell.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Merged #14/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));

  // looked at — the badge clears
  await expect(
    page.getByRole("button", { name: /^notifications$/ }),
  ).toBeVisible();
});

test("the channel URL survives a reload", async ({ page, api }) => {
  api.seedEvent("opened issue #12 — Bug in reconcile", { author: "octocat" });
  await openApp(page);
  await page.reload({ waitUntil: "networkidle" });
  await expect(main(page)).toContainText("Bug in reconcile");
});
