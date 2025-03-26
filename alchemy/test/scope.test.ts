import { describe, expect } from "bun:test";
import fs from "fs/promises";
import { alchemy } from "../src/alchemy";
import { File } from "../src/fs/file";
import { Scope } from "../src/scope";
import "../src/test/bun";

const test = alchemy.test(import.meta, {
  destroy: true,
});

describe("Scope", () => {
  test("should maintain scope context and track resources", async (scope) => {
    await File("file", {
      path: "test.txt",
      content: "Hello World",
    });

    const content = await fs.readFile("test.txt", "utf-8");
    expect(content).toBe("Hello World");

    expect(Scope.current).toEqual(scope);
    expect(scope.resources.size).toBe(1);
    expect(scope).toBe(scope);
  });
});
