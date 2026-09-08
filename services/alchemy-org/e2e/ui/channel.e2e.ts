/**
 * The CHANNEL — the org's one stream: world events as rows, the
 * operator's messages, cards from threads, the sidebar directory,
 * the bell.
 */
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

  await nav.getByRole("button", { name: "w-yours" }).click();
  await expect(page).toHaveURL(new RegExp(`${threadPath("t-you")}$`));
  await expect(
    nav.getByRole("button", { name: "w-yours" }),
  ).toHaveAttribute("aria-current", "page");
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
