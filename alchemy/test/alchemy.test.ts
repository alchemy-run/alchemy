import { describe, expect } from "bun:test";
import { alchemy } from "../src/alchemy.js";
import { BRANCH_PREFIX } from "./util.js";

import "../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("alchemy.run", async () => {
  describe("read mode", async () => {
    test("can create a scope", async (scope) => {
      expect(scope.phase).toBe("up");

      await alchemy.run("child", { phase: "read" }, async (child) => {
        expect(child.phase).toBe("read");
        expect(child.appName).toBeUndefined();
        expect(child.scopeName).toBe("child");
        expect(child.parent).toBe(scope);
      });
    });
  });
});
