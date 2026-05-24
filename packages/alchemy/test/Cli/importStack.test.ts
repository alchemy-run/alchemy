import { expect, test } from "vitest";

import { toImportSpecifier } from "../../src/Cli/commands/_shared";

test("importStack resolves stack entrypoints through file URLs", () => {
  const resolved = "/workspace/alchemy.run.ts";

  expect(toImportSpecifier(resolved)).toBe(
    "file:///workspace/alchemy.run.ts",
  );
});

test("importStack file URLs stay valid for Windows-style absolute paths", () => {
  const resolved = "D:\\workspace\\alchemy.run.ts";

  expect(toImportSpecifier(resolved)).toBe(
    "file:///D:/workspace/alchemy.run.ts",
  );
});