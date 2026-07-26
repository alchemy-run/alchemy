import type { Hunk, HunkLine, ParsedPatch, PatchOperation } from "./Types.ts";

const fail = (line: number, message: string): never => {
  throw new Error(`invalid patch at line ${line}: ${message}`);
};

/**
 * Parse the deliberately small apply-patch language. Parsing is pure so a
 * malformed patch cannot touch the workspace.
 */
export const parsePatch = (source: string): ParsedPatch => {
  const text = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();

  let cursor = 0;
  const currentLine = () => cursor + 1;
  const take = () => lines[cursor++]!;

  if (take() !== "*** Begin Patch") {
    fail(1, 'expected "*** Begin Patch"');
  }

  const operations: PatchOperation[] = [];
  while (cursor < lines.length && lines[cursor] !== "*** End Patch") {
    const header = take();

    if (header.startsWith("*** Add File: ")) {
      const path = header.slice("*** Add File: ".length);
      if (path.length === 0) fail(cursor, "Add File path is empty");
      const content: string[] = [];
      while (cursor < lines.length && !lines[cursor]!.startsWith("*** ")) {
        const line = take();
        if (!line.startsWith("+")) {
          fail(cursor, 'Add File lines must start with "+"');
        }
        content.push(line.slice(1));
      }
      if (content.length === 0) {
        fail(cursor, `Add File for ${JSON.stringify(path)} has no content`);
      }
      operations.push({ _tag: "AddFile", path, content: content.join("\n") });
      continue;
    }

    if (header.startsWith("*** Delete File: ")) {
      const path = header.slice("*** Delete File: ".length);
      if (path.length === 0) fail(cursor, "Delete File path is empty");
      operations.push({ _tag: "DeleteFile", path });
      continue;
    }

    if (header.startsWith("*** Update File: ")) {
      const path = header.slice("*** Update File: ".length);
      if (path.length === 0) fail(cursor, "Update File path is empty");
      let moveTo: string | undefined;
      if (lines[cursor]?.startsWith("*** Move to: ")) {
        moveTo = take().slice("*** Move to: ".length);
        if (moveTo.length === 0) fail(cursor, "Move to path is empty");
      }

      const hunks: Hunk[] = [];
      while (cursor < lines.length && lines[cursor]!.startsWith("@@")) {
        const patchLine = currentLine();
        const hunkHeader = take();
        if (hunkHeader !== "@@" && !hunkHeader.startsWith("@@ ")) {
          fail(patchLine, 'hunk header must be "@@" or start with "@@ "');
        }
        const hunkLines: HunkLine[] = [];
        let endOfFile = false;
        while (
          cursor < lines.length &&
          !lines[cursor]!.startsWith("@@") &&
          !lines[cursor]!.startsWith("*** ")
        ) {
          const line = take();
          const prefix = line[0];
          if (prefix !== " " && prefix !== "+" && prefix !== "-") {
            fail(cursor, 'hunk lines must start with " ", "+", or "-"');
          }
          hunkLines.push({
            kind:
              prefix === " " ? "context" : prefix === "+" ? "add" : "delete",
            text: line.slice(1),
          });
        }
        if (lines[cursor] === "*** End of File") {
          take();
          endOfFile = true;
        }
        if (hunkLines.length === 0) {
          fail(patchLine, "hunk is empty");
        }
        if (!hunkLines.some((line) => line.kind !== "context")) {
          fail(patchLine, "hunk contains context but no change");
        }
        hunks.push({
          header: hunkHeader === "@@" ? undefined : hunkHeader.slice(3),
          lines: hunkLines,
          endOfFile,
          patchLine,
        });
      }
      if (hunks.length === 0) {
        fail(cursor, `Update File for ${JSON.stringify(path)} has no hunks`);
      }
      operations.push({ _tag: "UpdateFile", path, moveTo, hunks });
      continue;
    }

    fail(
      cursor,
      `expected Add File, Delete File, or Update File header; got ${JSON.stringify(header)}`,
    );
  }

  if (cursor >= lines.length || take() !== "*** End Patch") {
    fail(currentLine(), 'expected "*** End Patch"');
  }
  if (cursor !== lines.length) {
    fail(currentLine(), "unexpected content after End Patch");
  }
  if (operations.length === 0) fail(2, "patch contains no operations");

  return { operations };
};
