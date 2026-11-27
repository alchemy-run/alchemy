import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { CommentOnIssue, IssueCommented } from "./CommentOnIssue.command.ts";
import { IssueId } from "./Issue.id.ts";
import { IssueLabeled, Label, LabelIssue } from "./LabelIssue.command.ts";
import { NotReported } from "./NotReported.rejection.ts";
import { IssueReported, ReportIssue } from "./ReportIssue.command.ts";

/**
 * One issue of the repository. Its rules are stated as `invariants` and
 * `transitions`, and `test/Board.verify.test.ts` proves that no command,
 * from a person or from a session, breaks them.
 */
export class Issue extends Domain.Aggregate("Issue", {
  id: IssueId,
  state: Schema.Union([
    Schema.TaggedStruct("Unreported", {}),
    Schema.TaggedStruct("Open", { label: Schema.NullOr(Label), replies: Schema.Int }),
  ]),
  initial: { _tag: "Unreported" },
  commands: [ReportIssue, LabelIssue, CommentOnIssue],
  keyOf: (command) => command.issueId,
  invariants: {
    RepliesAreCounted: (issue) => issue._tag !== "Open" || issue.replies >= 0,
  },
  transitions: {
    AReportedIssueStaysReported: ({ before, after }) =>
      before._tag !== "Open" || after._tag === "Open",
    OnlyLabelingChangesTheLabel: ({ before, after, command }) =>
      before._tag !== "Open" ||
      after._tag !== "Open" ||
      before.label === after.label ||
      command._tag === "LabelIssue",
    NoReplyIsLost: ({ before, after }) =>
      before._tag !== "Open" || after._tag !== "Open" || after.replies >= before.replies,
  },
  decide: {
    // GitHub delivers an event more than once: a second report changes nothing.
    ReportIssue: (issue, command) =>
      issue._tag === "Open"
        ? []
        : [new IssueReported({ title: command.title, body: command.body })],
    LabelIssue: (issue, command) =>
      issue._tag !== "Open" ? new NotReported() : [new IssueLabeled({ label: command.label })],
    CommentOnIssue: (issue, command) =>
      issue._tag !== "Open"
        ? new NotReported()
        : [new IssueCommented({ commentId: command.commentId, body: command.body })],
  },
  evolve: {
    IssueReported: () => ({ _tag: "Open" as const, label: null, replies: 0 }),
    IssueLabeled: (issue, event) =>
      issue._tag === "Open" ? { ...issue, label: event.label } : issue,
    IssueCommented: (issue) =>
      issue._tag === "Open" ? { ...issue, replies: issue.replies + 1 } : issue,
  },
}) {}
