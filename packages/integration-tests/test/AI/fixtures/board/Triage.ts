import * as AI from "@alchemy.run/ai";
import * as DomainAi from "@alchemy.run/domain/Ai";
import { TriageApi } from "./Board.ts";
import { IssueId } from "./Issue.id.ts";

/** The issue a session works on. */
export const issue = AI.Input("issue", IssueId);

const board = DomainAi.tools(TriageApi, { expose: ["LabelIssue", "IssueDetail.get"] });

/** Labels one issue of the board. */
export class Triage extends (AI.Process<Triage>()("Triage", {
  description: "Label one issue of the board as a bug, a feature or a question.",
})`
  You label issue ${issue} on ${board}.

  Get the issue's detail first: its key is the issue. Then send the label
  command for it: bug when something is broken, feature when something new
  is asked for, question otherwise. Reply with only the label you sent.

  Later messages are comments on the issue. When a comment asks for another
  label, send the label command again with that label.
`) {}
