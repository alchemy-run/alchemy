import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { Issue } from "./Issue.aggregate.ts";
import { Label } from "./LabelIssue.command.ts";

/** An issue as the board shows it. */
export class IssueDetail extends Domain.View(
  "IssueDetail",
  {
    from: [Issue],
    key: Issue,
    state: Schema.Struct({
      title: Schema.String,
      body: Schema.String,
      label: Schema.NullOr(Label),
      comments: Schema.Array(Schema.String),
    }),
    initial: { title: "", body: "", label: null, comments: [] },
    evolve: {
      IssueReported: (detail, event) => ({ ...detail, title: event.title, body: event.body }),
      IssueLabeled: (detail, event) => ({ ...detail, label: event.label }),
      IssueCommented: (detail, event) => ({
        ...detail,
        comments: [...detail.comments, event.body],
      }),
    },
  },
  { description: "An issue's title and body, its label, and the comments on it." },
) {}
