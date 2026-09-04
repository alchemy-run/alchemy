import { describe, expect, test } from "bun:test";
import { pathOf, tabOf, viewOf, withTab } from "../ui/lib/routes.ts";

/** Every view id the app routes, with its GitHub-shaped path. */
const cases: Array<[id: string, path: string]> = [
  ["pr:alchemy-run/alchemy#832", "/alchemy-run/alchemy/pull/832"],
  ["Reviewer:alchemy-run/alchemy#832", "/alchemy-run/alchemy/pull/832/review"],
  [
    "Reviewer:alchemy-run/alchemy#832::t-1",
    "/alchemy-run/alchemy/pull/832/review/threads/t-1",
  ],
  ["Engineer:alchemy-run/alchemy#832", "/alchemy-run/alchemy/pull/832/threads"],
  [
    "Engineer:alchemy-run/alchemy#832::t-9c1d",
    "/alchemy-run/alchemy/pull/832/threads/t-9c1d",
  ],
  [
    "Engineer:alchemy-run/alchemy/s-alpha",
    "/alchemy-run/alchemy/sessions/s-alpha",
  ],
  [
    "Engineer:alchemy-run/alchemy/s-alpha::t-review-notes",
    "/alchemy-run/alchemy/sessions/s-alpha/threads/t-review-notes",
  ],
  ["Engineer:main", "/sessions/main"],
  ["Engineer:main::t-2", "/sessions/main/threads/t-2"],
];

describe("routes", () => {
  test.each(cases)("%s ⇄ %s", (id, path) => {
    expect(pathOf(id)).toBe(path);
    expect(viewOf(path)).toBe(id);
  });

  test("nothing is percent-encoded in the everyday case", () => {
    for (const [, path] of cases) expect(path).not.toContain("%");
  });

  test("home and /pulls name no view", () => {
    expect(pathOf(undefined)).toBe("/");
    expect(viewOf("/")).toBeUndefined();
    expect(viewOf("/pulls")).toBeUndefined();
  });

  test("junk paths name no view", () => {
    expect(viewOf("/alchemy-run/alchemy")).toBeUndefined();
    expect(viewOf("/alchemy-run/alchemy/pull/abc")).toBeUndefined();
    expect(viewOf("/alchemy-run/alchemy/pull/1/nope")).toBeUndefined();
    expect(viewOf("/alchemy-run/alchemy/pull/1/threads/a/b")).toBeUndefined();
  });

  test("a PR's /files and /proposals tabs are the overview view on GitHub-shaped paths", () => {
    const pr = "/alchemy-run/alchemy/pull/832";
    expect(viewOf(`${pr}/files`)).toBe("pr:alchemy-run/alchemy#832");
    expect(viewOf(`${pr}/proposals`)).toBe("pr:alchemy-run/alchemy#832");
    expect(viewOf(`${pr}/files/x`)).toBeUndefined();
    expect(viewOf(`${pr}/other`)).toBeUndefined();
    expect(tabOf(pr)).toBe("conversation");
    expect(tabOf(`${pr}/files`)).toBe("files");
    expect(tabOf(`${pr}/proposals`)).toBe("proposals");
    expect(tabOf("/pulls")).toBe("conversation");
    expect(withTab(pr, "files")).toBe(`${pr}/files`);
    expect(withTab(`${pr}/files`, "files")).toBe(`${pr}/files`);
    expect(withTab(`${pr}/files`, "proposals")).toBe(`${pr}/proposals`);
    expect(withTab(`${pr}/proposals`, "conversation")).toBe(pr);
  });

  test("odd characters survive the round trip", () => {
    const id = "Engineer:alchemy-run/alchemy/s-alpha::feat/odd thing?";
    expect(viewOf(pathOf(id))).toBe(id);
  });
});
