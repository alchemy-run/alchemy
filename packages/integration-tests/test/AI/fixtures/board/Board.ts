import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { IssueId, Triage } from "./Triage.process.ts";

export const Label = Schema.Literals(["bug", "feature", "question"]);

export class IssueReported extends Domain.Event("IssueReported", { title: Schema.String }) {}
export class IssueLabeled extends Domain.Event("IssueLabeled", { label: Label }) {}
export class IssueCommented extends Domain.Event("IssueCommented", {
  commentId: Schema.String,
  body: Schema.String,
}) {}

export class ReportIssue extends Domain.Command("ReportIssue", {
  input: { issueId: IssueId, title: Schema.String },
  events: [IssueReported],
  rejects: [],
}) {}

/** What a process sends to say what an issue is. */
export class LabelIssue extends Domain.Command(
  "LabelIssue",
  {
    input: { issueId: IssueId, label: Label },
    events: [IssueLabeled],
    rejects: [],
  },
  { description: "Record what kind of issue this is: a bug, a feature or a question." },
) {}

export class CommentOnIssue extends Domain.Command("CommentOnIssue", {
  input: { issueId: IssueId, commentId: Schema.String, body: Schema.String },
  events: [IssueCommented],
  rejects: [],
}) {}

export class Issue extends Domain.Aggregate("Issue", {
  id: IssueId,
  state: Schema.Struct({ reported: Schema.Boolean }),
  initial: { reported: false },
  commands: [ReportIssue, LabelIssue, CommentOnIssue],
  keyOf: (command) => command.issueId,
  decide: {
    // A redelivered report changes nothing.
    ReportIssue: (issue, command) =>
      issue.reported ? [] : [new IssueReported({ title: command.title })],
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

/** An issue as the board shows it. */
export class IssueDetail extends Domain.View(
  "IssueDetail",
  {
    from: [Issue],
    key: Issue,
    state: Schema.Struct({
      title: Schema.String,
      label: Schema.NullOr(Label),
      comments: Schema.Array(Schema.String),
    }),
    initial: { title: "", label: null, comments: [] },
    evolve: {
      IssueReported: (detail, event) => ({ ...detail, title: event.title }),
      IssueLabeled: (detail, event) => ({ ...detail, label: event.label }),
      IssueCommented: (detail, event) => ({
        ...detail,
        comments: [...detail.comments, event.body],
      }),
    },
  },
  { description: "An issue's title, its label and the comments on it." },
) {}

/** A reported issue gets a Triage session; a comment on it goes to that session. */
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
            .send(`A comment on the issue: ${body}`, { requestId: commentId })
            .pipe(Effect.catchTag("NotStarted", () => Effect.void)),
      }).pipe(Effect.orDie);
    });
  }),
);

export class Board extends Domain.Model("Board", {
  aggregates: [Issue],
  views: [IssueDetail],
  policies: [IssueWork],
}) {}

/** What a Triage session may do to the board: read an issue, and label it. */
export class TriageApi extends Domain.Api("TriageApi", {
  model: Board,
  commands: ["LabelIssue"],
  views: ["IssueDetail"],
  streams: [],
  queries: [],
}) {}
