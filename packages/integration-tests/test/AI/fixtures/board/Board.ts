import * as Domain from "@alchemy.run/domain";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";
import { IssueId } from "./Issue.id.ts";
import { Labeler } from "./Labeler.ts";
import { Triage } from "./Triage.ts";

export { Labeler };

export const Label = Schema.Literals(["bug", "feature", "question"]);

export class IssueReported extends Domain.Event("IssueReported", { title: Schema.String }) {}
export class IssueLabeled extends Domain.Event("IssueLabeled", {
  label: Label,
  by: Schema.String,
}) {}

export class Unsigned extends Domain.Rejection("Unsigned") {}

/** Says who is labeling. Nothing here provides it: a session answers it with what it acts as. */
export class Signed extends RpcMiddleware.Service<Signed, { provides: Labeler }>()("Board/Signed", {
  error: Unsigned,
}) {}
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
    middleware: [Signed],
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
    LabelIssue: Effect.fn(function* (_, command) {
      const labeler = yield* Labeler;
      return [new IssueLabeled({ label: command.label, by: labeler.name })];
    }),
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
      labeledBy: Schema.NullOr(Schema.String),
      comments: Schema.Array(Schema.String),
    }),
    initial: { title: "", label: null, labeledBy: null, comments: [] },
    evolve: {
      IssueReported: (detail, event) => ({ ...detail, title: event.title }),
      IssueLabeled: (detail, event) => ({ ...detail, label: event.label, labeledBy: event.by }),
      IssueCommented: (detail, event) => ({
        ...detail,
        comments: [...detail.comments, event.body],
      }),
    },
  },
  { description: "An issue's title, its label and the comments on it." },
) {}

/** A reported issue is handed to its Triage session; a comment on it is passed on. */
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
        // Every command the session sends is sent as this labeler.
        IssueReported: () =>
          Effect.andThen(
            triage.start(source.id, { as: Labeler.context({ name: "triage-bot" }) }),
            session.send(`The issue is ${source.id}.`, { requestId: "start" }),
          ),
        IssueCommented: ({ body, commentId }) =>
          session.send(`A comment on the issue: ${body}`, { requestId: commentId }).pipe(
            // A comment on an issue that was never reported has no session.
            Effect.catchTag("NotStarted", () => Effect.void),
          ),
      }).pipe(Effect.orDie);
    });
  }),
);

export class Board extends Domain.Model("Board", {
  aggregates: [Issue],
  views: [IssueDetail],
  policies: [IssueWork],
}) {}
