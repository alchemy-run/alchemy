import { describe, expect } from "bun:test";
import { alchemy } from "../src/alchemy";
import { File } from "../src/fs";
import { Scope } from "../src/scope";
import "../src/test/bun";

describe("Scope", () => {
  alchemy.test(
    "should maintain scope context and track resources",
    async (scope) => {
      console.log("before");
      await File("test-file", {
        path: "test.txt",
        content: "Hello World",
      });
      console.log("after");
      expect(Scope.current).toEqual(scope);
      expect(scope.resources.size).toBe(1);
      expect(scope).toBe(scope);
    },
  );
});
