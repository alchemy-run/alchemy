import { describe, expect, test } from "bun:test";
import { parseFileFilter } from "../ui/lib/glob.ts";

const paths = [
  "src/review/Reviewer.ts",
  "src/review/ReadDiff.ts",
  "test/routes.test.ts",
  "ui/components/pull-request.tsx",
  "ui/index.css",
  "README.md",
  "e2e/fixtures/pr-147.diff",
];

const shown = (filter: string) => paths.filter(parseFileFilter(filter).matches);

describe("file filter globs", () => {
  test("empty keeps everything and is not active", () => {
    const filter = parseFileFilter("   ");
    expect(filter.active).toBe(false);
    expect(paths.filter(filter.matches)).toEqual(paths);
  });

  test("a basename glob matches at any depth", () => {
    expect(shown("*.ts")).toEqual([
      "src/review/Reviewer.ts",
      "src/review/ReadDiff.ts",
      "test/routes.test.ts",
    ]);
    expect(shown("*.{ts,tsx}")).toContain("ui/components/pull-request.tsx");
    expect(shown("*.test.ts")).toEqual(["test/routes.test.ts"]);
  });

  test("a glob with a slash matches the whole path", () => {
    expect(shown("src/**/*.ts")).toEqual([
      "src/review/Reviewer.ts",
      "src/review/ReadDiff.ts",
    ]);
    expect(shown("src/*.ts")).toEqual([]); // one segment only
    expect(shown("**/pull-request.tsx")).toEqual([
      "ui/components/pull-request.tsx",
    ]);
    expect(shown("ui/*")).toEqual(["ui/index.css"]);
  });

  test("a bare word matches anywhere, case-insensitively", () => {
    expect(shown("review")).toEqual([
      "src/review/Reviewer.ts",
      "src/review/ReadDiff.ts",
    ]);
    expect(shown("README")).toEqual(["README.md"]);
    expect(shown("ui/")).toEqual([
      "ui/components/pull-request.tsx",
      "ui/index.css",
    ]);
  });

  test("! excludes; only exclusions start from everything", () => {
    expect(shown("!*.test.ts !*.md")).toEqual([
      "src/review/Reviewer.ts",
      "src/review/ReadDiff.ts",
      "ui/components/pull-request.tsx",
      "ui/index.css",
      "e2e/fixtures/pr-147.diff",
    ]);
    expect(shown("*.ts !review")).toEqual(["test/routes.test.ts"]);
  });

  test("patterns separate on whitespace or commas; ? is one char", () => {
    expect(shown("*.md, *.css")).toEqual(["ui/index.css", "README.md"]);
    expect(shown("pr-14?.diff")).toEqual(["e2e/fixtures/pr-147.diff"]);
    expect(shown("pr-1?.diff")).toEqual([]);
  });

  test("regex metacharacters in a glob are literal", () => {
    expect(shown("pr-147.diff")).toEqual(["e2e/fixtures/pr-147.diff"]);
    expect(shown("*.d+ff")).toEqual([]);
    expect(shown("(README).md")).toEqual([]);
  });
});
