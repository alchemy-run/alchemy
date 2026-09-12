/**
 * The CHANNEL — the org's one stream: world events as rows, the
 * operator's messages, cards from threads, the sidebar directory,
 * the bell.
 */
import type { Page } from "@playwright/test";
import {
  acceptConfirm,
  declineConfirm,
  expect,
  main,
  openApp,
  REPO,
  test,
  threadNav,
  threadPath,
  type FakeApi,
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

test("the composer's model selector picks the channel agent's model on `Channel:main`", async ({
  page,
  api,
}) => {
  api.channelModel = "gpt-6-astra";
  await openApp(page);
  const select = page.getByRole("combobox", {
    name: "The channel agent's model",
  });
  // the pick is read from the channel, not the default
  await expect(select).toHaveAttribute("data-model", "gpt-6-astra");
  await expect(select).toContainText("GPT-6 Astra");

  // pick DeepSeek: one PUT on the channel's session
  await select.click();
  await page.getByRole("option", { name: /DeepSeek V4.1 Flash/ }).click();
  await expect
    .poll(() => api.modelPicks)
    .toEqual([{ session: "Channel:main", model: "deepseek-flash" }]);
  await expect(select).toHaveAttribute("data-model", "deepseek-flash");
  expect(api.channelModel).toBe("deepseek-flash");

  // there is no "default" entry to return to — the list is the
  // catalog alone; a pick is only ever replaced by another pick
  await select.click();
  await expect(page.getByRole("option", { name: /DeepSeek V4 Pro/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^Default/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
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
      title: "count the messages about reconcile",
      code: 'const hits = await search_messages({ q: "reconcile" });\nexport default hits;',
    },
    output: '{ "total": 3 }\n\n--- logs ---\nsearching the stream…',
    reply: "Looked at the stream — placing it on a thread.",
    reasoning: "The operator wants a count, so search first and tally.",
  });
  await openApp(page);

  // in flight: no agent reply after the message yet
  const pill = main(page).getByRole("button", { name: /working/ });
  await expect(pill).toBeVisible();

  // the pill opens the run's own session in the right-hand rail — the
  // exploration lives there, not in the channel stream
  await pill.click();
  const rail = page.getByRole("complementary", { name: "Run" });

  // the thought trace is one quiet line, no box, labelled by how long
  // the tick took (800ms here): its text stays folded and the chevron
  // only shows on hover; clicking opens the thought
  const trace = rail.locator("[data-reasoning]");
  await expect(trace).toContainText("Thought briefly");
  await expect(trace).not.toContainText("search first and tally");
  const chevron = trace.locator("svg");
  await expect(chevron).toHaveCSS("opacity", "0");
  await trace.hover();
  await expect(chevron).toHaveCSS("opacity", "1");
  await trace.getByRole("button").click();
  await expect(trace).toContainText("search first and tally");

  // the eval card is ONE line: the program's TITLE; open, it is a row
  // of tabs — output, logs, code — one pane at a time
  const card = rail.locator("[data-tool=eval]");
  await expect(card).toContainText("count the messages about reconcile");
  await expect(card).not.toContainText("total");
  await expect(card.getByRole("tab")).toHaveCount(0);
  await expect(rail).not.toContainText("searching the stream…");
  await expect(rail).not.toContainText("search_messages");
  await card.getByRole("button").first().click();
  // the output opens first — the answer; logs and source a tab away,
  // never two panes at once
  await expect(card.getByRole("tab")).toHaveText([
    /^output · 1 line$/,
    /^logs · 1 line$/,
    /^code · 2 lines$/,
  ]);
  await expect(card.getByRole("tab", { name: /^output/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // …a structured output reads as YAML, not the JSON the model saw
  await expect(card).toContainText("total: 3");
  await expect(card).not.toContainText('"total"');
  await expect(rail).not.toContainText("searching the stream…");
  await card.getByRole("tab", { name: /^logs/ }).click();
  await expect(rail).toContainText("searching the stream…");
  await expect(card).not.toContainText("total");
  await expect(rail).not.toContainText("search_messages");
  // switching tabs does not move the page: the tab stays put
  const codeTab = card.getByRole("tab", { name: /^code/ });
  const before = (await codeTab.boundingBox())!.y;
  await codeTab.click();
  await expect(rail).toContainText("search_messages");
  await expect(rail).not.toContainText("searching the stream…");
  expect((await codeTab.boundingBox())!.y).toBeCloseTo(before, 0);

  // the run's FINAL reply belongs to the channel, not the rail
  await expect(rail).not.toContainText(
    "Looked at the stream — placing it on a thread.",
  );

  // the reply lands → the pill settles to "ran"
  api.pushMessage({ kind: "agent", text: "Placed it on w-triage." });
  await expect(main(page).getByRole("button", { name: /^ran$/ })).toBeVisible();

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
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await declineConfirm(page);
  await expect.poll(() => api.deletedMessages).toEqual([]);
  await expect(main(page)).toContainText("delete me please");

  // confirmed: the DELETE lands and the socket's remove frame drops
  // the row from the view
  await rowOf(page, "delete me please").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await acceptConfirm(page);
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
  await main(page)
    .getByText("event three")
    .click({ modifiers: ["Shift"] });
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
  await main(page)
    .getByText("event three")
    .click({ modifiers: ["Shift"] });
  await expect(selected).toHaveCount(3);
  // ⌘-click toggles one more in
  await main(page)
    .getByText("event five")
    .click({ modifiers: ["Meta"] });
  await expect(selected).toHaveCount(4);
  // ...and out again
  await main(page)
    .getByText("event five")
    .click({ modifiers: ["Meta"] });
  await expect(selected).toHaveCount(3);
  await main(page)
    .getByText("event five")
    .click({ modifiers: ["Meta"] });

  // right-click INSIDE the selection keeps it — the menu counts it
  await rowOf(page, "event two").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete 4 messages" }).click();
  await acceptConfirm(page);
  await expect
    .poll(() => api.deletedMessages)
    .toEqual([one.id, two.id, three.id, five.id]);
  await expect(main(page)).not.toContainText("event one");
  await expect(main(page)).toContainText("event four");

  // clicking the lone selected row again deselects it; ⌘-click toggles
  // one out; Escape clears
  await main(page).getByText("event four").click();
  await expect(selected).toHaveCount(1);
  await main(page).getByText("event four").click();
  await expect(selected).toHaveCount(0);
  await main(page).getByText("event four").click();
  await expect(selected).toHaveCount(1);
  await main(page)
    .getByText("event four")
    .click({ modifiers: ["Meta"] });
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
  // the original stays lit while the reply is typed — the menu closing
  // dropped the click selection, but not this
  const replying = main(page).locator("[data-seq][data-replying]");
  await expect(replying).toHaveCount(1);
  await expect(replying).toContainText("Bug in reconcile");

  // send: the POST names the original; the echoed row quotes it
  await composer.fill("on it — fixing now");
  await composer.press("Enter");
  await expect
    .poll(() => api.replies)
    .toEqual([{ text: "on it — fixing now", replyTo: [original.id] }]);
  await expect(bar).toBeHidden();
  await expect(replying).toHaveCount(0);
  const reply = rowOf(page, "on it — fixing now");
  await expect(reply).toContainText("octocat");
  await expect(
    reply.getByRole("button", { name: /Bug in reconcile/ }),
  ).toBeVisible();
});

test("⌘-click while replying adds to the reply; the bar counts them", async ({
  page,
  api,
}) => {
  const first = api.seedEvent("event one", { author: "octocat" });
  api.seedEvent("event two", { author: "hubot" });
  const third = api.seedEvent("event three", { author: "octocat" });
  await openApp(page);

  await rowOf(page, "event two").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reply" }).click();
  const bar = main(page).getByLabel("Replying to", { exact: true });
  await expect(bar).toContainText("Replying to hubot");

  // ⌘-click adds (in display order), the header adapts, both rows lit
  const replying = main(page).locator("[data-seq][data-replying]");
  await rowOf(page, "event three").click({ modifiers: ["ControlOrMeta"] });
  await expect(bar).toContainText("Replying to 2 messages");
  await expect(replying).toHaveCount(2);
  await rowOf(page, "event one").click({ modifiers: ["ControlOrMeta"] });
  await expect(bar).toContainText("Replying to 3 messages");
  await expect(replying).toHaveCount(3);
  // the list of originals is collapsed behind the count by default;
  // the header toggles it
  await expect(bar).not.toContainText("event two");
  const toggle = bar.getByRole("button", { name: "Replying to 3 messages" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(bar).toContainText("event two");
  await expect(bar).toContainText("event three");
  // ⌘-click again removes; so does the row's ✕
  await rowOf(page, "event three").click({ modifiers: ["ControlOrMeta"] });
  await expect(bar).toContainText("Replying to 2 messages");
  await rowOf(page, "event three").click({ modifiers: ["ControlOrMeta"] });
  await bar.getByRole("button", { name: "Stop replying to hubot" }).click();
  await expect(bar).toContainText("Replying to 2 messages");
  await expect(bar).not.toContainText("event two");
  await expect(bar).toContainText("event three");
  await bar.getByRole("button", { name: "Replying to 2 messages" }).click();
  await expect(bar).not.toContainText("event three");

  const composer = page.getByRole("textbox", { name: "Message the channel" });
  await composer.fill("both of these");
  await composer.press("Enter");
  await expect
    .poll(() => api.replies)
    .toEqual([{ text: "both of these", replyTo: [first.id, third.id] }]);
  await expect(bar).toBeHidden();
  await expect(replying).toHaveCount(0);
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

test("a push's commit is a link with a hover card, like a PR ref", async ({
  page,
  api,
}) => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  api.seedEvent(
    `pushed [\`${sha.slice(0, 7)}\`](https://github.com/${REPO}/commit/${sha}) to \`main\` — fix reconcile`,
  );
  await openApp(page);

  const link = main(page).getByRole("link", { name: sha.slice(0, 7) });
  await expect(link).toHaveAttribute(
    "href",
    `https://github.com/${REPO}/commit/${sha}`,
  );
  await link.hover();
  // the harness blocks api.github.com, so the card settles on its
  // fallback line — proof the commit URL shape opens a hover card
  await expect(page.getByText(`${REPO}@${sha.slice(0, 7)}`)).toBeVisible();
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
  await page.getByRole("menuitem", { name: "Delete thread" }).click();
  await declineConfirm(page);
  await expect.poll(() => api.deletedThreads).toEqual([]);
  await expect(row).toBeVisible();

  // confirmed: the DELETE lands and the directory frame drops the row;
  // the view was on the channel and stays there
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete thread" }).click();
  await acceptConfirm(page);
  await expect.poll(() => api.deletedThreads).toEqual(["t-old"]);
  await expect(threadNav(page)).not.toContainText("container-fixes");
  await expect(threadNav(page)).toContainText("w-reconcile");
  await expect(
    page.getByRole("textbox", { name: "Message the channel" }),
  ).toBeVisible();
});

test("a thread being deleted shows as deleting until the server has torn it down", async ({
  page,
  api,
}) => {
  api.seedThread({ id: "t-slow", name: "w-slow", turn: "you" });
  const release = api.holdThreadDelete();
  await openApp(page, threadPath("t-slow"));

  await page
    .getByRole("complementary", { name: "Thread state" })
    .getByRole("button", { name: "Delete thread" })
    .click();
  await acceptConfirm(page);
  await expect.poll(() => api.deletedThreads).toEqual(["t-slow"]);

  // the DELETE is in flight: the row stays, spinning; the pane's
  // button is disabled; the body says what is happening
  const row = threadNav(page).locator("[data-thread='t-slow']");
  await expect(row).toHaveAttribute("data-deleting", "");
  await expect(row).toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("button", { name: "Deleting…" })).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Deleting this thread");
  // a second delete while one is in flight is a no-op
  expect(api.deletedThreads).toEqual(["t-slow"]);

  // the server answers: the row goes, the view falls back to the channel
  release();
  await expect(threadNav(page)).not.toContainText("w-slow");
  await expect(page).toHaveURL(/\/$/);
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
  await page.getByRole("menuitem", { name: "Delete 2 threads" }).click();
  await acceptConfirm(page);
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
    .getByRole("button", { name: "Pull request opened for #12", exact: true })
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
  const dialog = page.getByRole("dialog");
  // the new one is marked, and the row names its thread
  await expect(dialog.locator("[data-notification][data-unseen]")).toHaveCount(
    1,
  );
  await expect(dialog).toContainText("w-fix");
  await dialog
    .getByRole("button", { name: "Open the thread: Merged #14" })
    .click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));

  // looked at — the badge clears
  await expect(
    page.getByRole("button", { name: /^notifications$/ }),
  ).toBeVisible();
});

const seedQuestionCard = (api: FakeApi) => {
  api.seedThread({ id: "t-1", name: "w-fix", title: "Fix the bug" });
  api.seedEvent("opened issue #12 — Bug in reconcile", { author: "octocat" });
  return api.seedCard(
    { thread: "t-1", title: "Which base branch?" },
    "#14 is ready to open. Against `main`, or the `release/2.x` branch the issue names?",
  );
};

test("a card is answered on the card: the words reach the thread's agent, quoting the question", async ({
  page,
  api,
}) => {
  seedQuestionCard(api);
  await openApp(page);

  const card = main(page).locator("[data-card]");
  await expect(card).toContainText("Which base branch?");
  await card
    .getByRole("button", { name: "Answer: Which base branch?" })
    .click();
  // the box takes focus; the card row underneath did not get selected
  const box = card.getByLabel("Your answer");
  await expect(box).toBeFocused();
  await expect(main(page).locator("[data-selected]")).toHaveCount(0);
  await box.fill("main — release/2.x is frozen");
  await box.press("ControlOrMeta+Enter");

  // ONE steer, to the card's thread, the card's headline quoted first
  await expect
    .poll(() => api.steered)
    .toEqual([
      {
        thread: "t-1",
        text: "> Which base branch?\n\nmain — release/2.x is frozen",
      },
    ]);
  // the card now says so, and links into the thread
  await expect(card.locator("[data-answered]")).toContainText("Answered");
  await expect(card.getByLabel("Your answer")).toHaveCount(0);
  await card.getByRole("button", { name: "see the thread" }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
});

test("Escape drops an answer being typed; Cancel too — nothing is sent", async ({
  page,
  api,
}) => {
  seedQuestionCard(api);
  await openApp(page);

  const card = main(page).locator("[data-card]");
  await card
    .getByRole("button", { name: "Answer: Which base branch?" })
    .click();
  await card.getByLabel("Your answer").fill("hmm");
  await card.getByLabel("Your answer").press("Escape");
  await expect(card.getByLabel("Your answer")).toHaveCount(0);
  await card
    .getByRole("button", { name: "Answer: Which base branch?" })
    .click();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(card.getByLabel("Your answer")).toHaveCount(0);
  // Send stays off for an empty answer
  await card
    .getByRole("button", { name: "Answer: Which base branch?" })
    .click();
  await expect(card.getByRole("button", { name: "Send" })).toBeDisabled();
  expect(api.steered).toEqual([]);
});

test("the bell answers inline too — from any page, without leaving it", async ({
  page,
  api,
}) => {
  seedQuestionCard(api);
  api.seedThread({ id: "t-2", name: "w-other", title: "Elsewhere" });
  // the operator is on another thread when the question comes
  await openApp(page, threadPath("t-2"));

  await page.getByRole("button", { name: /notifications, 1 new/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Answer: Which base branch?" })
    .click();
  const box = dialog.getByLabel("Your answer");
  await expect(box).toBeFocused();
  await box.fill("main");
  await dialog.getByRole("button", { name: "Send" }).click();

  await expect
    .poll(() => api.steered)
    .toEqual([{ thread: "t-1", text: "> Which base branch?\n\nmain" }]);
  await expect(dialog.locator("[data-answered]")).toContainText("Answered");
  // still where they were
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-2")}$`));
  // and the link goes to the thread that asked
  await dialog.getByRole("button", { name: "see the thread" }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-1")}$`));
});

test("the bell jumps to the card itself: home, scrolled to the row, flashed", async ({
  page,
  api,
}) => {
  // a long stream, the card early in it — the jump has to scroll
  api.seedThread({ id: "t-1", name: "w-fix", title: "Fix the bug" });
  const card = api.seedCard(
    { thread: "t-1", title: "Which base branch?" },
    "main or release/2.x?",
  );
  for (let n = 0; n < 40; n++) {
    api.seedEvent(`opened issue #${100 + n} — filler ${n}`, {
      author: "octocat",
    });
  }
  api.seedThread({ id: "t-2", name: "w-other", title: "Elsewhere" });
  await openApp(page, threadPath("t-2"));

  await page.getByRole("button", { name: /notifications, 1 new/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Jump to the card: Which base branch?" })
    .click();

  await expect(page).toHaveURL(/\/$/);
  const row = main(page).locator(`[data-seq="${card.seq}"]`);
  await expect(row).toHaveAttribute("data-flash", "");
  await expect(row).toBeInViewport();
  // the popover went with the jump
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("the channel URL survives a reload", async ({ page, api }) => {
  api.seedEvent("opened issue #12 — Bug in reconcile", { author: "octocat" });
  await openApp(page);
  await page.reload({ waitUntil: "networkidle" });
  await expect(main(page)).toContainText("Bug in reconcile");
});
