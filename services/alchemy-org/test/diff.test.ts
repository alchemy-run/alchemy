import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { toGitDiff, type ChangedFile } from "../ui/lib/diff.ts";
import {
  buildPullRequestFilesPage,
  toUnifiedDiff,
} from "../src/github/PullRequest.ts";

const file = (over: Partial<ChangedFile>): ChangedFile => ({
  filename: "src/a.ts",
  previousFilename: undefined,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,2 +1,2 @@\n-old\n+new\n context",
  blobUrl: "https://github.com/o/r/blob/sha/src/a.ts",
  ...over,
});

describe("toGitDiff", () => {
  test("re-dresses a modified file's hunks so the renderer parses them", () => {
    const diff = toGitDiff(file({}))!;
    expect(diff).toBe(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        " context",
        "",
      ].join("\n"),
    );
    const [meta] = parsePatchFiles(diff).flatMap((patch) => patch.files);
    expect(meta?.name).toBe("src/a.ts");
    expect(meta?.hunks).toHaveLength(1);
  });

  test("added and removed files point one side at /dev/null", () => {
    const added = toGitDiff(file({ status: "added" }))!;
    expect(added).toContain(
      "new file mode 100644\n--- /dev/null\n+++ b/src/a.ts",
    );
    const removed = toGitDiff(file({ status: "removed" }))!;
    expect(removed).toContain(
      "deleted file mode 100644\n--- a/src/a.ts\n+++ /dev/null",
    );
    const [meta] = parsePatchFiles(added).flatMap((patch) => patch.files);
    expect(meta?.type).toBe("new");
  });

  test("a rename keeps both names; a pure rename has a header and no hunks", () => {
    const renamed = toGitDiff(
      file({ previousFilename: "src/old.ts", status: "renamed" }),
    )!;
    expect(renamed.split("\n").slice(0, 5)).toEqual([
      "diff --git a/src/old.ts b/src/a.ts",
      "rename from src/old.ts",
      "rename to src/a.ts",
      "--- a/src/old.ts",
      "+++ b/src/a.ts",
    ]);
    const pure = toGitDiff(
      file({
        previousFilename: "src/old.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patch: undefined,
      }),
    );
    expect(pure).toBe(
      "diff --git a/src/old.ts b/src/a.ts\nrename from src/old.ts\nrename to src/a.ts\n",
    );
  });

  test("a file GitHub sent without a patch has nothing to render", () => {
    expect(toGitDiff(file({ patch: undefined }))).toBeUndefined();
    expect(
      toGitDiff(file({ patch: undefined, additions: 0, deletions: 0 })),
    ).toBeUndefined();
  });

  test("a trailing newline on the patch is not doubled", () => {
    const diff = toGitDiff(file({ patch: "@@ -1 +1 @@\n-a\n+b\n" }))!;
    expect(diff.endsWith("+b\n")).toBe(true);
    expect(diff.endsWith("+b\n\n")).toBe(false);
  });
});

describe("toUnifiedDiff", () => {
  test("joins every file, noting in place the ones GitHub withheld", () => {
    const diff = toUnifiedDiff([
      file({}),
      file({
        filename: "assets/logo.png",
        additions: 0,
        deletions: 0,
        patch: undefined,
        blobUrl: "https://github.com/o/r/blob/sha/assets/logo.png",
      }),
      file({
        filename: "dist/bundle.js",
        additions: 40_000,
        deletions: 0,
        status: "added",
        patch: undefined,
      }),
    ]);
    const blocks = diff.split(/^(?=diff --git )/m).filter(Boolean);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("+new");
    expect(blocks[1]).toContain(
      "# modified, +0 −0: no diff from GitHub (binary, or not diffed) — https://github.com/o/r/blob/sha/assets/logo.png",
    );
    expect(blocks[2]).toContain(
      "# added, +40000 −0: diff too large for GitHub to serve",
    );
    // still one parseable patch — the parser sees three files
    expect(parsePatchFiles(diff).flatMap((patch) => patch.files)).toHaveLength(
      3,
    );
  });
});

describe("buildPullRequestFilesPage", () => {
  const raw = (filename: string) => ({
    sha: "0",
    filename,
    status: "modified" as const,
    additions: 1,
    deletions: 0,
    changes: 1,
    blob_url: `https://github.com/o/r/blob/sha/${filename}`,
    raw_url: "",
    contents_url: "",
    patch: "@@ -1 +1 @@\n-a\n+b",
  });

  test("a full page points at the next one; a short page is the last", () => {
    const full = buildPullRequestFilesPage([raw("a"), raw("b")], 3, 2);
    expect(full.next).toBe(4);
    expect(full.files.map((f) => f.filename)).toEqual(["a", "b"]);
    expect(buildPullRequestFilesPage([raw("a")], 4, 2).next).toBeNull();
    expect(buildPullRequestFilesPage([], 5, 2).next).toBeNull();
  });

  test("projects GitHub's record onto the wire shape", () => {
    const [file] = buildPullRequestFilesPage(
      [{ ...raw("a"), previous_filename: "z", status: "renamed" }],
      1,
    ).files;
    expect(file).toEqual({
      filename: "a",
      previousFilename: "z",
      status: "renamed",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@\n-a\n+b",
      blobUrl: "https://github.com/o/r/blob/sha/a",
    });
  });
});
