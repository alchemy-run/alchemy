import { sameElements } from "@/Util/equal";
import { describe, expect, test } from "alchemy-test";

describe("sameElements", () => {
  test("ignores order", () => {
    expect(sameElements([1, 2, 3], [3, 1, 2])).toBe(true);
    expect(sameElements(["a", "b"], ["b", "a"])).toBe(true);
  });

  test("ignores repeats", () => {
    expect(sameElements([1, 1, 2], [2, 1])).toBe(true);
    expect(sameElements(["web", "web"], ["web"])).toBe(true);
  });

  test("treats an omitted list as empty", () => {
    expect(sameElements(undefined, [])).toBe(true);
    expect(sameElements([], undefined)).toBe(true);
    expect(sameElements(undefined, undefined)).toBe(true);
    expect(sameElements(undefined, [1])).toBe(false);
  });

  test("differs on a missing or extra member", () => {
    expect(sameElements([1, 2], [1])).toBe(false);
    expect(sameElements([1], [1, 2])).toBe(false);
    expect(sameElements(["a"], ["b"])).toBe(false);
  });

  test("does not confuse numbers with their string forms", () => {
    expect(sameElements<string | number>([1], ["1"])).toBe(false);
  });
});
