import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { testAlchemy } from "../repos.ts";
import { issue, reason } from "../vocabulary.ts";

export class CloseIssue extends AI.Tool<CloseIssue>()("closeIssue")`
Close ${issue} for ${reason}. Closing is a claim that the work is
done or will never be done — the reason must cite the evidence. The
reason is posted as a comment so the thread records why it closed.` {}

/**
 * `issues.update` to state=closed, with the rationale posted as a
 * comment first — the close should never be silent. `state_reason`
 * derives from the rationale: a duplicate/wontfix reads as
 * "not_planned", completed work as "completed".
 */
export const CloseIssueLive = Layer.effect(
  CloseIssue,
  Effect.gen(function* () {
    const updateIssue = yield* GitHub.UpdateIssue(testAlchemy);
    const comment = yield* GitHub.CreateIssueComment(testAlchemy);
    return ((input: { issue: { number: number }; reason: string }) =>
      Effect.gen(function* () {
        yield* comment({
          issue_number: input.issue.number,
          body: input.reason,
        });
        const notPlanned = /duplicate|won'?t fix|wontfix|not planned|invalid/i.test(
          input.reason,
        );
        yield* updateIssue({
          issue_number: input.issue.number,
          state: "closed",
          state_reason: notPlanned ? "not_planned" : "completed",
        });
        return `closed #${input.issue.number}`;
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "GitHub.IssueNotFound"
            ? `issue #${input.issue.number} does not exist`
            : `${error.operation} failed: ${error.message}`,
        ),
      )) as never;
  }),
);
