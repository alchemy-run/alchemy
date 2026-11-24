import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Issue } from "./Issue.aggregate.ts";
import { IssueId } from "./Issue.id.ts";
import { IssueSession } from "./IssueSession.aggregate.ts";
import { Label } from "./LabelIssue.command.ts";

/** The one key the list is kept under. */
export const ALL = "all";

/**
 * Every issue of the board, newest first, with whether its agent is working:
 * what the page's sidebar shows. It is one entry, which suits a board of a
 * few hundred issues.
 */
export class IssueList extends Domain.View("IssueList", {
  from: [Issue, IssueSession],
  key: Schema.String,
  keyOf: {
    IssueReported: () => ALL,
    IssueLabeled: () => ALL,
    IssueCommented: () => ALL,
    ActivityRecorded: () => ALL,
  },
  state: Schema.Struct({
    /** Newest first. */
    order: Schema.Array(IssueId),
    issues: Schema.Record(
      IssueId,
      Schema.Struct({ title: Schema.String, label: Schema.NullOr(Label), replies: Schema.Int }),
    ),
    /** The issues whose agent is working now. */
    working: Schema.Array(IssueId),
  }),
  initial: { order: [], issues: {}, working: [] },
  evolve: {
    IssueReported: (list, event, { source }) => ({
      ...list,
      order: [source.id, ...list.order.filter((id) => id !== source.id)],
      issues: { ...list.issues, [source.id]: { title: event.title, label: null, replies: 0 } },
    }),
    IssueLabeled: (list, event, { source }) => {
      const issue = list.issues[source.id];
      return issue === undefined
        ? list
        : { ...list, issues: { ...list.issues, [source.id]: { ...issue, label: event.label } } };
    },
    IssueCommented: (list, _, { source }) => {
      const issue = list.issues[source.id];
      return issue === undefined
        ? list
        : {
            ...list,
            issues: { ...list.issues, [source.id]: { ...issue, replies: issue.replies + 1 } },
          };
    },
    ActivityRecorded: (list, event, { source }) => {
      const others = list.working.filter((id) => id !== source.id);
      return { ...list, working: event.status === "working" ? [...others, source.id] : others };
    },
  },
}) {}
