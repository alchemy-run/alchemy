import * as Domain from "@alchemy.run/domain";
import { pipe } from "effect/Function";
import * as Optic from "effect/Optic";
import * as Schema from "effect/Schema";
import { Issue } from "./Issue.aggregate.ts";
import { IssueId } from "./Issue.id.ts";
import { Label } from "./LabelIssue.command.ts";

/** The one key the list is kept under. */
export const ALL = "all";

const Listed = Schema.Struct({
  title: Schema.String,
  label: Schema.NullOr(Label),
  replies: Schema.Int,
});

const State = Schema.Struct({
  /** Newest first. */
  order: Schema.Array(IssueId),
  issues: Schema.Record(IssueId, Listed),
});

// Optics into the list. One that focuses on an issue leaves the list as it
// is when the issue is not in it, which keeps evolve total.
const list = Optic.id<typeof State.Type>();
const order = list.key("order");
const listed = (id: IssueId) => list.key("issues").optionalKey(id);
const issue = (id: IssueId) => list.key("issues").at(id);

const without = (id: IssueId) => (ids: ReadonlyArray<IssueId>) => ids.filter((each) => each !== id);

/**
 * Every issue of the board, newest first: what the page's sidebar shows. It
 * is one entry, which suits a board of a few hundred issues.
 */
export class IssueList extends Domain.View("IssueList", {
  from: [Issue],
  key: Schema.String,
  keyOf: {
    IssueReported: () => ALL,
    IssueLabeled: () => ALL,
    IssueCommented: () => ALL,
  },
  state: State,
  initial: { order: [], issues: {} },
  evolve: {
    IssueReported: (state, event, { source }) =>
      pipe(
        state,
        order.modify((ids) => [source.id, ...without(source.id)(ids)]),
        listed(source.id).modify(() => ({ title: event.title, label: null, replies: 0 })),
      ),
    IssueLabeled: (state, event, { source }) =>
      issue(source.id)
        .key("label")
        .modify(() => event.label)(state),
    IssueCommented: (state, _, { source }) =>
      issue(source.id)
        .key("replies")
        .modify((replies) => replies + 1)(state),
  },
}) {}
