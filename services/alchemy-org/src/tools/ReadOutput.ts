import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { ToolOutputStore } from "../lib/ToolOutputStore.ts";
import { truncateHead } from "../lib/Output.ts";

const outputId = AI.Parameter("outputId", S.String)`
Opaque output ID returned by grep, glob, or bash when inline output
was truncated.`;

const offset = AI.Parameter(
  "offset",
  S.optionalKey(S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(1)))),
)`
1-indexed line to start reading from (default 1).`;

const limit = AI.Parameter(
  "limit",
  S.optionalKey(
    S.Int.pipe(
      S.check(S.isGreaterThanOrEqualTo(1), S.isLessThanOrEqualTo(2000)),
    ),
  ),
)`
Maximum lines to return (1-2000, default 2000).`;

export class ReadOutput extends AI.Tool<ReadOutput>()("readOutput")`
Read complete tool output retained under ${outputId}. Page large
artifacts with ${offset} and ${limit}. IDs are scoped to the current
local toolbox and reveal no host filesystem path.` {}

export const ReadOutputLive = Layer.effect(
  ReadOutput,
  Effect.gen(function* () {
    const store = yield* ToolOutputStore;
    return ((input: { outputId: string; offset?: number; limit?: number }) =>
      Effect.gen(function* () {
        const text = yield* store.read(input.outputId);
        const lines = text.split("\n");
        const start = input.offset ?? 1;
        if (start > lines.length) {
          return yield* Effect.fail(
            `offset ${start} is past the end of ${input.outputId} (${lines.length} lines)`,
          );
        }
        const max = input.limit ?? 2000;
        const page = lines.slice(start - 1, start - 1 + max).join("\n");
        const truncated = truncateHead(page, {
          maxLines: max,
          maxBytes: 50_000,
        });
        const end = start + truncated.shownLines - 1;
        return end < lines.length
          ? `${truncated.text}\n[Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to continue.]`
          : truncated.text;
      })) as never;
  }),
);
