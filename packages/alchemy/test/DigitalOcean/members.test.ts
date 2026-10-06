import { sameMembers, unique } from "@/DigitalOcean/members";
import { describe, expect, it } from "alchemy-test";

describe(
  "members",
  { tags: ["unit", "provider:digitalocean", "local"] },
  () => {
    it("unique drops repeats and keeps the first order", () => {
      expect(unique(["b", "a", "b"])).toEqual(["b", "a"]);
      expect(unique(undefined)).toEqual([]);
    });

    it("sameMembers ignores order and repeats", () => {
      expect(sameMembers(["a", "b"], ["b", "a", "a"])).toBe(true);
    });

    it("sameMembers treats an omitted list as empty", () => {
      expect(sameMembers(undefined, [])).toBe(true);
      expect(sameMembers(null, undefined)).toBe(true);
      expect(sameMembers(undefined, ["a"])).toBe(false);
    });

    it("sameMembers tells a subset from the full list", () => {
      expect(sameMembers(["a"], ["a", "b"])).toBe(false);
      expect(sameMembers(["a", "c"], ["a", "b"])).toBe(false);
    });
  },
);
