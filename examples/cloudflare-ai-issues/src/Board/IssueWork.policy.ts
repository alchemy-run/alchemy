import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { Triage } from "../Triage.process.ts";
import { IssueCommented } from "./CommentOnIssue.command.ts";
import { Issue } from "./Issue.aggregate.ts";
import { IssueReported } from "./ReportIssue.command.ts";
import { replied, started } from "./Said.ts";

/** A reported issue is handed to its Triage session; a reply on it is passed on. */
export class IssueWork extends Domain.Policy("IssueWork", {
  from: Issue,
  on: [IssueReported, IssueCommented],
}) {}

export const IssueWorkLive = IssueWork.toLayer(
  Effect.gen(function* () {
    const triage = yield* Triage;
    return Effect.fn(function* ({ source, event }) {
      const session = triage.get(source.id);
      yield* Match.valueTags(event, {
        // The same id however often the event is delivered, so the issue is taken up once.
        IssueReported: () => session.send(started(source.id), { requestId: "start" }),
        IssueCommented: ({ body, commentId }) =>
          session.send(replied(body), { requestId: commentId }),
      }).pipe(Effect.orDie);
    });
  }),
);
