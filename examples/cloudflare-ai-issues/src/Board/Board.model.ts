import * as Domain from "@alchemy.run/domain";
import { Issue } from "./Issue.aggregate.ts";
import { IssueDetail } from "./IssueDetail.view.ts";
import { IssueSession } from "./IssueSession.aggregate.ts";
import { IssueWork } from "./IssueWork.policy.ts";
import { SessionStatus } from "./SessionStatus.view.ts";
import { Transcript } from "./Transcript.stream.ts";
import { Transcripts } from "./Transcripts.projection.ts";

/** The issue board: every issue, how it shows, and what happens when one changes. */
export class Board extends Domain.Model("Board", {
  aggregates: [Issue, IssueSession],
  views: [IssueDetail, SessionStatus],
  policies: [IssueWork],
  projections: [Transcripts],
  streams: [Transcript],
  sometimes: {
    /** The board can do its job: an issue can end up labeled. */
    AnIssueGetsLabeled: (board) =>
      board.Issue.some((issue) => issue.state._tag === "Open" && issue.state.label !== null),
  },
}) {}
