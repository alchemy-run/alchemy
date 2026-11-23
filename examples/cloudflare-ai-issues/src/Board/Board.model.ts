import * as Domain from "@alchemy.run/domain";
import { Issue } from "./Issue.aggregate.ts";
import { IssueDetail } from "./IssueDetail.view.ts";
import { IssueWork } from "./IssueWork.policy.ts";

/** The issue board: every issue, how it shows, and what happens when one changes. */
export class Board extends Domain.Model("Board", {
  aggregates: [Issue],
  views: [IssueDetail],
  policies: [IssueWork],
  sometimes: {
    /** The board can do its job: an issue can end up labeled. */
    AnIssueGetsLabeled: (board) =>
      board.Issue.some((issue) => issue.state._tag === "Open" && issue.state.label !== null),
  },
}) {}
