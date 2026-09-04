/**
 * The executor posts a review's inline comments in the shape GitHub
 * ACCEPTS: a side on every comment, and BOTH sides on a range — GitHub
 * rejects a `start_line` that comes without its `start_side`, with a
 * 422 that blames the line numbers ("start_line must precede the end
 * line"). Proposals filed before sides were recorded must still land.
 */
import { expect, test } from "bun:test";
import { toGitHubReviewComment } from "../src/github/ProposalActions.ts";

test("a single-line comment names its side, HEAD unless told otherwise", () => {
  expect(
    toGitHubReviewComment({ path: "src/sum.ts", line: 4, body: "nit" }),
  ).toEqual({ path: "src/sum.ts", body: "nit", line: 4, side: "RIGHT" });
  expect(
    toGitHubReviewComment({
      path: "src/sum.ts",
      line: 4,
      side: "LEFT",
      body: "why drop this?",
    }),
  ).toEqual({
    path: "src/sum.ts",
    body: "why drop this?",
    line: 4,
    side: "LEFT",
  });
});

test("a range carries start_side — the same side as the anchor when unrecorded", () => {
  // a proposal from before sides were stored
  expect(
    toGitHubReviewComment({
      path: "src/sum.ts",
      start_line: 2,
      line: 4,
      body: "the whole helper",
    }),
  ).toEqual({
    path: "src/sum.ts",
    body: "the whole helper",
    line: 4,
    side: "RIGHT",
    start_line: 2,
    start_side: "RIGHT",
  });
  // a range over deleted lines
  expect(
    toGitHubReviewComment({
      path: "src/sum.ts",
      start_line: 10,
      start_side: "LEFT",
      line: 12,
      side: "LEFT",
      body: "these guarded the empty case",
    }),
  ).toEqual({
    path: "src/sum.ts",
    body: "these guarded the empty case",
    line: 12,
    side: "LEFT",
    start_line: 10,
    start_side: "LEFT",
  });
});

test("a single-line comment never grows a start_side", () => {
  expect(
    toGitHubReviewComment({
      path: "src/sum.ts",
      line: 4,
      side: "RIGHT",
      body: "nit",
    }),
  ).not.toHaveProperty("start_side");
});
