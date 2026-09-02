/**
 * Against a running `alchemy dev` stack (`E2E_LIVE=1`): the fake in
 * `../ui` can't prove the wiring — real PR data from GitHub, a real
 * shell behind the terminal socket, sessions that exist server-side.
 * Every session this file opens, it deletes.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

interface Board {
  repo: string;
  prs: Array<{ number: number; title: string; state: string }>;
}

const firstOpenPull = async (request: APIRequestContext) => {
  const board = (await (await request.get("/api/board")).json()) as Board;
  const pull = board.prs.find((row) => row.state === "open");
  test.skip(pull === undefined, "no open pull request on the connected repo");
  return { repo: board.repo, ...pull! };
};

const deleteChat = (request: APIRequestContext, id: string) =>
  request.delete(`/api/chats/${encodeURIComponent(id)}`);

test("the overview renders the pull request as GitHub has it", async ({
  page,
  request,
}) => {
  const pull = await firstOpenPull(request);
  await page.goto(`/#${encodeURIComponent(`pr:${pull.repo}#${pull.number}`)}`);
  await expect(
    page.getByRole("main").getByRole("heading", { level: 1 }),
  ).toContainText(pull.title);
  await expect(page.getByRole("main")).toContainText(
    "opened this pull request",
  );
  await expect(page.getByRole("tab", { name: "Pull request" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("checkout converges the PR's machine onto its head", async ({
  request,
}) => {
  const pull = await firstOpenPull(request);
  const response = await request.post(`/api/prs/${pull.number}/checkout`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    key: string;
    ref: string;
    headSha: string;
  };
  expect(body.key).toBe(`${pull.repo}#${pull.number}`);
  expect(body.ref).toBeTruthy();
  expect(body.headSha).toMatch(/^[0-9a-f]{40}$/);
});

const chatIds = async (request: APIRequestContext) =>
  (
    (await (await request.get("/api/chats")).json()) as Array<{ id: string }>
  ).map((row) => row.id);

test("a PR thread is a server-side session that survives a reload", async ({
  page,
  request,
}) => {
  const pull = await firstOpenPull(request);
  const prefix = `Engineer:${pull.repo}#${pull.number}`;
  // whatever threads the operator already has on this PR stay theirs —
  // the test only ever deletes the one it opened
  const before = new Set(await chatIds(request));
  let created: string | undefined;
  try {
    await page.goto(
      `/#${encodeURIComponent(`pr:${pull.repo}#${pull.number}`)}`,
    );
    await page
      .getByRole("main")
      .getByRole("button", { name: "thread" })
      .click();
    await expect(page).toHaveURL(/Engineer%3A/);

    await expect
      .poll(async () => {
        created = (await chatIds(request)).find(
          (id) => id.startsWith(prefix) && !before.has(id),
        );
        return created;
      })
      .toBeDefined();

    const label = await page.getByRole("tab", { selected: true }).textContent();
    await page.reload();
    await expect(page.getByRole("tab", { selected: true })).toHaveText(
      label ?? "",
    );
  } finally {
    if (created !== undefined) await deleteChat(request, created);
  }
});

test("a terminal reaches a real shell on the PR's machine", async ({
  page,
  request,
}) => {
  const pull = await firstOpenPull(request);
  await page.goto(`/#${encodeURIComponent(`pr:${pull.repo}#${pull.number}`)}`);
  await page
    .getByRole("main")
    .getByRole("button", { name: "terminal" })
    .click();
  await expect(page.getByRole("main")).toContainText(
    "connected — the session's machine, a real shell",
    { timeout: 120_000 },
  );
});
