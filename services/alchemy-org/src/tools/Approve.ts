import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Approvals } from "../Approvals.ts";
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
 * The autonomy dial's LOUD position: log and auto-approve without
 * recording — merges stay blocked. Useful when a human drives merges.
 */
export const ApproveConsole = Layer.succeed(Approve, ((input: {
  pr: { owner: string; repository: string; number: number; url: string };
}) =>
  Effect.gen(function* () {
    yield* Effect.logWarning(
      `ApproveConsole AUTO-APPROVING ${input.pr.owner}/${input.pr.repository}#${input.pr.number} — no human gate is wired (TODO: HumanGate)`,
    );
    return `approved (WARNING: auto-approved by ApproveConsole — no human reviewed this)`;
  })) as never);
