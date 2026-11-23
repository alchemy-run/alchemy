import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CommentOnIssue, IssueCommented } from "./CommentOnIssue.command.ts";
import { IssueId } from "./Issue.id.ts";
import { IssueLabeled, LabelIssue } from "./LabelIssue.command.ts";
import { IssueReported, ReportIssue } from "./ReportIssue.command.ts";

/** One issue of the repository. */
export class Issue extends Domain.Aggregate("Issue", {
  id: IssueId,
  state: Schema.Struct({ reported: Schema.Boolean }),
  initial: { reported: false },
  commands: [ReportIssue, LabelIssue, CommentOnIssue],
  keyOf: (command) => command.issueId,
  decide: {
    // GitHub delivers an event more than once: a second report changes nothing.
    ReportIssue: (issue, command) =>
      issue.reported ? [] : [new IssueReported({ title: command.title, body: command.body })],
    LabelIssue: (_, command) => [new IssueLabeled({ label: command.label })],
    CommentOnIssue: (_, command) => [
      new IssueCommented({ commentId: command.commentId, body: command.body }),
    ],
  },
  evolve: {
    IssueReported: () => ({ reported: true }),
    IssueLabeled: (issue) => issue,
    IssueCommented: (issue) => issue,
  },
}) {}
