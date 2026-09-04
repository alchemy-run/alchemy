import { setEquals } from "@/Util/equal";
import { describe, expect, test } from "alchemy-test";

describe("setEquals", () => {
  test("ignores order", () => {
    expect(setEquals([1, 2, 3], [3, 1, 2])).toBe(true);
    expect(setEquals(["a", "b"], ["b", "a"])).toBe(true);
  });

  test("ignores repeats", () => {
    expect(setEquals([1, 1, 2], [2, 1])).toBe(true);
    expect(setEquals(["web", "web"], ["web"])).toBe(true);
  });

  test("treats an omitted list as empty", () => {
    expect(setEquals(undefined, [])).toBe(true);
    expect(setEquals([], undefined)).toBe(true);
    expect(setEquals(undefined, undefined)).toBe(true);
    expect(setEquals(undefined, [1])).toBe(false);
  });

  test("differs on a missing or extra member", () => {
    expect(setEquals([1, 2], [1])).toBe(false);
    expect(setEquals([1], [1, 2])).toBe(false);
    expect(setEquals(["a"], ["b"])).toBe(false);
  });

  test("does not confuse numbers with their string forms", () => {
    expect(setEquals<string | number>([1], ["1"])).toBe(false);
  });
});
