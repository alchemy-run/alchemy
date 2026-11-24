import * as Domain from "@alchemy.run/domain";
import { Board } from "./Board.model.ts";

/**
 * Everything that changes an issue: GitHub's events, and a session's label.
 * Recording a session's activity is left out: its object sends that itself.
 */
export class BoardApi extends Domain.Api("BoardApi", {
  model: Board,
  commands: ["ReportIssue", "LabelIssue", "CommentOnIssue"],
}) {}
