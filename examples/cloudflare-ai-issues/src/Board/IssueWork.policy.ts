import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { IssueCommented } from "./CommentOnIssue.command.ts";
import { Issue } from "./Issue.aggregate.ts";
import { IssueReported } from "./ReportIssue.command.ts";
import { Triage } from "./Triage.process.ts";

/** A reported issue gets a Triage session; a reply on it goes to that session. */
export class IssueWork extends Domain.Policy("IssueWork", {
  from: Issue,
  on: [IssueReported, IssueCommented],
}) {}

export const IssueWorkLive = IssueWork.toLayer(
  Effect.gen(function* () {
    const triage = yield* Triage;
    return Effect.fn(function* ({ source, event }) {
      yield* Match.valueTags(event, {
        IssueReported: () => triage.start(source.id, { issue: source.id }),
        IssueCommented: ({ body, commentId }) =>
          triage
            .get(source.id)
            .send(`A reply on the issue: ${body}`, { requestId: commentId })
            // A reply on an issue that was never reported here has no session.
            .pipe(Effect.catchTag("NotStarted", () => Effect.void)),
      }).pipe(Effect.orDie);
    });
  }),
);
