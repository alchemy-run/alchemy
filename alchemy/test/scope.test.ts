import { describe, expect } from "bun:test";
import fs from "node:fs/promises";
import { alchemy } from "../src/alchemy.js";
import { destroy } from "../src/destroy.js";
import { File } from "../src/fs/file.js";
import { Scope } from "../src/scope.js";
import { BRANCH_PREFIX } from "./util.js";

import "../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Scope", () => {
  test("should maintain scope context and track resources", async (scope) => {
    try {
      await File("file", {
        path: "test.txt",
        content: "Hello World",
      });

      const content = await fs.readFile("test.txt", "utf-8");
      expect(content).toBe("Hello World");

      expect(Scope.current).toEqual(scope);
      expect(scope.resources.size).toBe(1);
      expect(scope).toBe(scope);
    } finally {
      await destroy(scope);
    }
  });
});
