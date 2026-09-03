/**
 * The DO store's routing invariant: a proposal's id CARRIES the
 * partition (the pull request) that holds it, so get/revise/resolve
 * reach the owning Durable Object without a lookup. Anything that is
 * not one of our ids routes nowhere.
 */
import { expect, test } from "bun:test";
import {
  mintId,
  partitionOf,
  partitionOfId,
} from "../src/github/ProposalsDO.ts";

test("a proposal partitions on its pull request, or its repository before one exists", () => {
  expect(partitionOf("sam-goodwin/alchemy", 1234)).toBe(
    "sam-goodwin/alchemy#1234",
  );
  expect(partitionOf("sam-goodwin/alchemy", undefined)).toBe(
    "sam-goodwin/alchemy",
  );
});

test("the id round-trips its partition, URL-safe", () => {
  for (const partition of [
    "sam-goodwin/alchemy#1234",
    "sam-goodwin/alchemy",
    "org-with-a-long-name/repository_with.dots-and-dashes#9",
    "a/b#1",
  ]) {
    const id = mintId(partition);
    expect(id).toMatch(/^proposal-[A-Za-z0-9_-]+-[0-9a-f-]{36}$/);
    expect(encodeURIComponent(id)).toBe(id);
    expect(partitionOfId(id)).toBe(partition);
  }
});

test("an id this store never minted routes nowhere", () => {
  expect(partitionOfId("proposal-1")).toBeUndefined();
  expect(
    partitionOfId("proposal-8f3a0c1e-0000-4000-8000-000000000000"),
  ).toBeUndefined();
  expect(partitionOfId("")).toBeUndefined();
});
