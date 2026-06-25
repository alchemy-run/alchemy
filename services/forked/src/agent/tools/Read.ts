import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { ReadTracker } from "../ReadTracker.ts";
import { Sandbox } from "../Sandbox.ts";

const DEFAULT_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`;

export const filePath = AI.Parameter("filePath", S.String)`
The path to the file or directory to read, relative to the workspace root.`;

export const offset = AI.Parameter("offset")(S.Number.pipe(S.optional))`
The line number to start reading from (1-indexed).`;

export const limit = AI.Parameter("limit")(S.Number.pipe(S.optional))`
The maximum number of lines to read (defaults to 2000).`;

export class Read extends AI.Tool<Read>()("read")`
Read a file or directory from the sandbox filesystem. If the path does not
exist, an error is returned.

Usage:
- The ${filePath} parameter should be a path relative to the workspace root.
- By default, this tool returns up to 2000 lines from the start of the file.
- The ${offset} parameter is the line number to start from (1-indexed).
- To read later sections, call this tool again with a larger ${offset} and a
  ${limit}.
- Use the grep tool to find specific content in large files.
- If you are unsure of the correct file path, use the glob tool to look up
  filenames by glob pattern.
- Contents are returned with each line prefixed by its line number as
  \`<line>: <content>\`. For example, if a file has contents "foo\\n", you will
  receive "1: foo". For directories, entries are returned one per line (without
  line numbers) with a trailing \`/\` for subdirectories.
- Any line longer than 2000 characters is truncated.
- Call this tool in parallel when you know there are multiple files you want to
  read.
- Avoid tiny repeated slices (30 line chunks). If you need more context, read a
  larger window.` {}

export const ReadLive = Layer.effect(
  Read,
  Effect.gen(function* () {
    const sandbox = yield* Sandbox;
    const tracker = yield* ReadTracker;

    return Effect.fn("read")(function* (params) {
      const { filePath, offset, limit } = params as {
        filePath: string;
        offset?: number;
        limit?: number;
      };

      if (yield* sandbox.isDirectory(filePath)) {
        const entries = yield* sandbox.list(filePath);
        return {
          type: "directory" as const,
          path: filePath,
          output: entries
            .map((e) => (e.directory ? `${e.name}/` : e.name))
            .join("\n"),
        };
      }

      const contents = yield* sandbox.readFile(filePath);
      yield* tracker.markRead(filePath);

      const lines = contents.split("\n");
      const start = Math.max(0, (offset ?? 1) - 1);
      const slice = lines.slice(start, start + (limit ?? DEFAULT_LIMIT));
      const text = slice
        .map((line, i) => {
          const truncated =
            line.length > MAX_LINE_LENGTH
              ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX
              : line;
          return `${start + i + 1}: ${truncated}`;
        })
        .join("\n");

      return {
        type: "file" as const,
        path: filePath,
        totalLines: lines.length,
        truncated: start + slice.length < lines.length,
        output: text,
      };
    });
  }),
);
