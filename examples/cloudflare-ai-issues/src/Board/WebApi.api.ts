import * as Domain from "@alchemy.run/domain";
import { Board } from "./Board.model.ts";

/**
 * What the web app may do and read: report an issue, reply on one, and read
 * every view and stream. Labeling and recording are left out: only the
 * session's object sends those.
 */
export class WebApi extends Domain.Api("WebApi", {
  model: Board,
  commands: ["ReportIssue", "CommentOnIssue"],
}) {}
