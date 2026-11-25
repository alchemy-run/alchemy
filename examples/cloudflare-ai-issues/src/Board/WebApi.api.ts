import * as Domain from "@alchemy.run/domain";
import { Board } from "./Board.model.ts";

/**
 * What the web app may do and read: report an issue, reply on one, and read
 * every view, `Triage` among them. Labeling is left out: only a session
 * sends it.
 */
export class WebApi extends Domain.Api("WebApi", {
  model: Board,
  commands: ["ReportIssue", "CommentOnIssue"],
}) {}
