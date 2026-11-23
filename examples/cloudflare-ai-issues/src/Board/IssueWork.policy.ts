import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { IssueCommented } from "./CommentOnIssue.command.ts";
import { Issue } from "./Issue.aggregate.ts";
import { IssueReported } from "./ReportIssue.command.ts";
import { Triager } from "./Triager.external.ts";

/** A reported issue is handed to the triager; a reply on it is passed on. */
export class IssueWork extends Domain.Policy("IssueWork", {
  from: Issue,
  on: [IssueReported, IssueCommented],
}) {}

export const IssueWorkLive = IssueWork.toLayer(
  Effect.gen(function* () {
    const triager = yield* Triager;
    return Effect.fn(function* ({ source, event }) {
      yield* Match.valueTags(event, {
        IssueReported: () => triager.start({ issue: source.id }),
        IssueCommented: ({ body, commentId }) =>
          triager.tell({ issue: source.id, text: `A reply on the issue: ${body}`, id: commentId }),
      });
    });
  }),
);
