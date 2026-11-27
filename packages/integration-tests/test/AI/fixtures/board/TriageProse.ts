import { Board } from "./Board.ts";
import { Triage } from "./Triage.ts";

/** What a Triage session is told. It mentions the board, whose policy holds the process. */
export const TriageLive = Triage.toLayer({
  description: "Label one issue of the board as a bug, a feature or a question.",
})`
  You label one issue of the board. Your first message says which.

  Get its detail first with ${Board.IssueDetail}: its key is the issue. Then
  send ${Board.LabelIssue} for it: bug when something is broken, feature
  when something new is asked for, question otherwise. Reply with only the
  label you sent.

  Later messages are comments on the issue. When a comment asks for another
  label, send ${Board.LabelIssue} again with that label.
`;
