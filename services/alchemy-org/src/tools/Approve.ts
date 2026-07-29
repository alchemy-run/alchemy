import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Approvals } from "../services/Approvals.ts";
import { testAlchemy } from "../Repos.ts";
import { pr } from "../Vocabulary.ts";

export class Approve extends AI.Tool<Approve>()("approve")`
Approve ${pr} for merge. Only approve a change you have actually read
and judged against its issue — your approval is what authorizes the
merge.` {}

/**
 * The review verdict, RECORDED (the merge tool ratifies against
 * the {@link Approvals} ledger) and VISIBLE (a PR comment). Recorded
 * in-process rather than as a GitHub review because the factory runs
 * on one token and GitHub rejects self-approval.
 */
export const ApproveRecorded = Layer.effect(
  Approve,
  Effect.gen(function* () {
    const approvals = yield* Approvals;
    const comment = yield* GitHub.CreateIssueComment(testAlchemy);
    return ((input: {
      pr: { owner: string; repository: string; number: number; url: string };
    }) =>
      Effect.gen(function* () {
        yield* approvals.record(input.pr);
        yield* comment({
          issue_number: input.pr.number,
          body: "✅ **Approved** — judged against the originating issue's acceptance criteria.",
        }).pipe(
          Effect.mapError(
            (error) => `${error.operation} failed: ${error.message}`,
          ),
        );
        return `approved #${input.pr.number} — the merge is now authorized`;
      })) as never;
  }),
);

/**
 * The HUMAN-IN-THE-LOOP position of the autonomy dial: the reviewer's
 * verdict becomes a RECOMMENDATION — posted on the PR, never recorded
 * in the {@link Approvals} ledger — so the merge tool only ever
 * succeeds on a real APPROVED GitHub review from a human (the second
 * source it already honors). Same contract, same charters; the second
 * key of the two-key ceremony moves from the machine to a person,
 * purely by Layer composition.
 *
 * The human is, structurally, a slow tool implementation: the owner's
 * merge refusal is model-visible ("a human review is pending"), it
 * parks on `remind_me`, and the approval arrives as world state the
 * next attempt observes.
 */
export const ApproveRequested = Layer.effect(
  Approve,
  Effect.gen(function* () {
    const comment = yield* GitHub.CreateIssueComment(testAlchemy);
    return ((input: {
      pr: { owner: string; repository: string; number: number; url: string };
    }) =>
      Effect.gen(function* () {
        yield* comment({
          issue_number: input.pr.number,
          body:
            "✅ **Reviewer recommends approval** — judged against the " +
            "originating issue's acceptance criteria.\n\n" +
            "_Supervised mode: this verdict is advisory. A maintainer's " +
            "APPROVED review on this pull request authorizes the merge._",
        }).pipe(
          Effect.mapError(
            (error) => `${error.operation} failed: ${error.message}`,
          ),
        );
        return (
          `recommendation posted on #${input.pr.number} — the merge stays ` +
          `blocked until a human submits an APPROVED review on GitHub`
        );
      })) as never;
  }),
);
