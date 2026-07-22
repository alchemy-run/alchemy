import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { WorkspaceFiles } from "../internal/WorkspaceFiles.ts";
import { path } from "../vocabulary.ts";

const offset = AI.Parameter("offset", S.optionalKey(S.Int))`
1-indexed line to start reading from. Negative values count from the
end (-1 is the final line). Zero is invalid.`;

const limit = AI.Parameter(
  "limit",
  S.optionalKey(
    S.Int.pipe(
      S.check(S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(2000)),
    ),
  ),
)`
Maximum number of lines to return (default and cap: 2000).`;

export class ReadFile extends AI.Tool<ReadFile>()("readFile")`
Read the file at ${path}. Output is line-numbered ("N: content") and
truncated to 2000 lines / 50KB — page large files with ${offset} and
${limit}. Read whole regions at once; avoid tiny slices. Every result
includes the SHA-256 digest required by editFile/writeFile to prove
you are changing the version you actually read.` {}

const DEFAULT_LIMIT = 2000;
const MAX_BYTES = 50_000;
const MAX_LINE_CHARS = 2000;
const encoder = new TextEncoder();

/** Local physics over the {@link Workspace} checkout. */
export const ReadFileLocal = Layer.effect(
  ReadFile,
  Effect.gen(function* () {
    const files = yield* WorkspaceFiles;
    return ((input: { path: string; offset?: number; limit?: number }) =>
      Effect.gen(function* () {
        if (input.offset === 0 || !Number.isInteger(input.offset ?? 1)) {
          return yield* Effect.fail("offset must be a non-zero integer");
        }
        const snapshot = yield* files.readText(input.path);
        const lines = snapshot.content.split("\n");
        const requested = input.offset ?? 1;
        const start =
          requested < 0 ? Math.max(1, lines.length + requested + 1) : requested;
        if (start > lines.length) {
          return yield* Effect.fail(
            `offset ${start} is past the end of ${input.path} (${lines.length} lines)`,
          );
        }
        const pageLimit = Math.min(input.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT);
        const window: string[] = [];
        let bytes = 0;
        let end = start - 1;
        for (
          let index = start - 1;
          index < lines.length && window.length < pageLimit;
          index++
        ) {
          const source = lines[index]!;
          const shown =
            source.length > MAX_LINE_CHARS
              ? `${source.slice(0, MAX_LINE_CHARS)}… [line truncated]`
              : source;
          const line = `${index + 1}: ${shown}`;
          const lineBytes = encoder.encode(`${line}\n`).byteLength;
          if (bytes + lineBytes > MAX_BYTES) {
            if (window.length === 0) {
              window.push(
                `${index + 1}: ${shown.slice(0, 1000)}… [line exceeds 50KB output budget]`,
              );
              end = index + 1;
            }
            break;
          }
          window.push(line);
          bytes += lineBytes;
          end = index + 1;
        }
        const content = window.join("\n");
        const page =
          end < lines.length
            ? `${content}\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`
            : content;
        return `${page}\n[SHA-256: ${snapshot.digest}]`;
      })) as never;
  }),
);
