import * as Domain from "@alchemy.run/domain";
import { Board } from "./Board.model.ts";

/** What a Triage session may do to the board: read an issue, and label it. */
export class TriageApi extends Domain.Api("TriageApi", {
  model: Board,
  commands: ["LabelIssue"],
  views: ["IssueDetail"],
  streams: [],
  queries: [],
}) {}
