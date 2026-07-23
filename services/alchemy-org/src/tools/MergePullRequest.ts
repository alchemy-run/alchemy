import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Approvals } from "../approvals.ts";
import { testAlchemy } from "../repos.ts";
import { pr } from "../vocabulary.ts";

export class MergePullRequest extends AI.Tool<MergePullRequest>()(
  "mergePullRequest",
)`
Merge ${pr}. Fails unless the pull request has an approved review
and green checks — merging is the last act of resolving an issue,
never a way to skip review.` {}

/**
 * Merge a pull request — refuses without an approval (the tool's own
 * prose promises this; this layer enforces it over the RAW
 * `GitHub.MergePullRequest` binding). Two approval sources are
 * honored: the Reviewer's recorded verdict (the {@link Approvals}
 * ledger — the factory's one token cannot APPROVE-review its own PRs)
 * and a real GitHub APPROVED review from a human.
 */
export const MergePullRequestLive = Layer.effect(
  MergePullRequest,
  Effect.gen(function* () {
    const approvals = yield* Approvals;
    const listReviews = yield* GitHub.ListPullRequestReviews(testAlchemy);
    const merge = yield* GitHub.MergePullRequest(testAlchemy);
    return ((input: {
      pr: { owner: string; repository: string; number: number; url: string };
    }) =>
      Effect.gen(function* () {
        const recorded = yield* approvals.isApproved(input.pr);
        if (!recorded) {
          const reviews = yield* listReviews({
            pull_number: input.pr.number,
          }).pipe(
            Effect.mapError(
              (error) => `${error.operation} failed: ${error.message}`,
            ),
          );
          if (!reviews.some((review) => review.state === "APPROVED")) {
            return yield* Effect.fail(
              `refusing to merge #${input.pr.number}: no approval — ask the Reviewer first`,
            );
          }
        }
        const merged = yield* merge({ pull_number: input.pr.number }).pipe(
          Effect.mapError(
            (error) => `${error.operation} failed: ${error.message}`,
          ),
        );
        return `merged #${input.pr.number}: ${merged.sha}`;
      })) as never;
  }),
);
