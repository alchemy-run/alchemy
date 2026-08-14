import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "../Repos.ts";
import { pr } from "../Vocabulary.ts";

export class ReadDiff extends AI.Tool<ReadDiff>()("readDiff")`
Read ${pr} in full: its title, body (the "Closes #N" linkage and the
author's claims), and the unified diff — the change itself, exactly as
it would merge. An oversized diff is head-previewed; the full text is
retained as an opaque ID readable with readOutput.` {}

/** Header + body via `pulls.get`, then the diff via `format: "diff"`.
 *  Deliberately UNBOUNDED — the spill net (lib/Spill.ts) previews and
 *  retains oversized results, so nothing is discarded. */
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
        return `${header}\n${diff}`;
      })) as never;
  }),
);
