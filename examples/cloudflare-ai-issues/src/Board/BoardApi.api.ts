import * as Domain from "@alchemy.run/domain";
import { Board } from "./Board.model.ts";

/** Everything that changes an issue: GitHub's events, and a session's label. */
export class BoardApi extends Domain.Api("BoardApi", {
  model: Board,
  commands: ["ReportIssue", "LabelIssue", "CommentOnIssue"],
}) {}
