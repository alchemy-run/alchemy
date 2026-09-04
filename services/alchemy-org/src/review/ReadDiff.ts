import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import {
  buildPullRequestFilesPage,
  PULL_FILES_PAGE_SIZE,
  toUnifiedDiff,
} from "../github/PullRequest.ts";
import { primary } from "../github/Repos.ts";

export const PullRequestRef = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Int,
  url: S.String,
});

export const pr = AI.Parameter("pr", PullRequestRef)`
A reference to a pull request in the repository.`;

export class ReadDiff extends (AI.Tool<ReadDiff>(import.meta)("readDiff")`
Read ${pr} in full: its title, body (the "Closes #N" linkage and the
author's claims), and the unified diff — the change itself, exactly as
it would merge. An oversized diff is head-previewed; the full text is
retained as an opaque ID readable with readOutput.`) {}

/** GitHub's refusal to serve a PR's diff whole — over 20 000 lines or
 *  300 files (`{"code":"too_large"}` on `pulls.get` as a diff). */
const isTooLarge = (error: GitHub.GitHubApiError): boolean =>
  error.message.includes("too_large") ||
  error.message.includes("exceeded the maximum number of lines");

/** GitHub lists at most 3 000 files per PR, 100 to a page. */
const MAX_FILE_PAGES = 30;

/** Header + body via `pulls.get`, then the diff via `format: "diff"` —
 *  or, when GitHub refuses that as too large, assembled file by file
 *  from `pulls.listFiles`, so a big PR reads the same as a small one.
 *  Deliberately UNBOUNDED — the spill net (artifacts/SpillingTools.ts) previews and
 *  retains oversized results, so nothing is discarded. */
export const ReadDiffLive = Layer.effect(
  ReadDiff,
  Effect.gen(function* () {
    const getPullRequest = yield* GitHub.GetPullRequest(primary);
    const listFiles = yield* GitHub.ListPullRequestFiles(primary);

    const pagedDiff = (pull_number: number) =>
      Effect.gen(function* () {
        const files: GitHub.ListPullRequestFilesResponse = [];
        for (let page = 1; page <= MAX_FILE_PAGES; page++) {
          const batch = yield* listFiles({
            pull_number,
            per_page: PULL_FILES_PAGE_SIZE,
            page,
          });
          files.push(...batch);
          if (batch.length < PULL_FILES_PAGE_SIZE) break;
        }
        return toUnifiedDiff(buildPullRequestFilesPage(files, 1).files);
      });

    const wholeDiff = (pull_number: number) =>
      getPullRequest({ pull_number, format: "diff" }).pipe(
        Effect.catch((error) =>
          isTooLarge(error) ? pagedDiff(pull_number) : Effect.fail(error),
        ),
      );

    return ((input: {
      pr: { owner: string; repository: string; number: number; url: string };
    }) =>
      Effect.gen(function* () {
        const [pull, diff] = yield* Effect.all(
          [
            getPullRequest({ pull_number: input.pr.number }),
            wholeDiff(input.pr.number),
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
