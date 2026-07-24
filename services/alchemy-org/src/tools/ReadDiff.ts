import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "../repos.ts";
import { pr } from "../vocabulary.ts";

export class ReadDiff extends AI.Tool<ReadDiff>()("readDiff")`
Read ${pr} in full: its title, body (the "Closes #N" linkage and the
author's claims), and the unified diff — the change itself, exactly as
it would merge. Large diffs are tail-noted with their full size.` {}

/** Cap what one tool result puts in the reviewer's context. */
const MAX_DIFF_CHARS = 60_000;

/** Header + body via `pulls.get`, then the diff via `format: "diff"`. */
export const ReadDiffLive = Layer.effect(
  ReadDiff,
  Effect.gen(function* () {
    const getPullRequest = yield* GitHub.GetPullRequest(testAlchemy);
    return ((input: {
      pr: { owner: string; repository: string; number: number; url: string };
    }) =>
      Effect.gen(function* () {
        const [pull, diff] = yield* Effect.all(
          [
            getPullRequest({ pull_number: input.pr.number }),
            getPullRequest({ pull_number: input.pr.number, format: "diff" }),
          ],
          { concurrency: 2 },
        ).pipe(
          Effect.mapError(
            (error) => `${error.operation} failed: ${error.message}`,
          ),
        );
        const header = [
          `#${pull.number} ${pull.title}`,
          `${pull.head.ref} -> ${pull.base.ref}`,
          "",
          pull.body ?? "(no description)",
          "",
          "--- diff ---",
        ].join("\n");
        const body =
          diff.length <= MAX_DIFF_CHARS
            ? diff
            : `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated: ${diff.length} chars total]`;
        return `${header}\n${body}`;
      })) as never;
  }),
);
