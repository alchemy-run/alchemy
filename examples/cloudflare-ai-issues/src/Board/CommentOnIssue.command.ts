import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { IssueId } from "./Issue.id.ts";
import { NotReported } from "./NotReported.rejection.ts";

export class IssueCommented extends Domain.Event("IssueCommented", {
  commentId: Schema.String,
  body: Schema.String,
}) {}

/** Someone replied on an issue. */
export class CommentOnIssue extends Domain.Command("CommentOnIssue", {
  input: { issueId: IssueId, commentId: Schema.String, body: Schema.String },
  events: [IssueCommented],
  rejects: [NotReported],
}) {}
