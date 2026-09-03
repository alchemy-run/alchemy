import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { Artifacts, pageArtifact } from "./Artifacts.ts";

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
    const artifacts = yield* Artifacts;
    return ((input: { outputId: string; offset?: number; limit?: number }) =>
      pageArtifact(artifacts, input)) as never;
  }),
);
