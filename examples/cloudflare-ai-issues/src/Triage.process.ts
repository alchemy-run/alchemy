import * as AI from "@alchemy.run/ai";
import { Answering } from "./Answering.process.ts";
import { Board } from "./Board/Board.model.ts";
import { PostAnswer } from "./PostAnswer.tool.ts";
import { SearchIssues } from "./SearchIssues.tool.ts";

/** Read the code, answer on the issue, and label it on the board: the one view and the one command it mentions. */
export class Triage extends (AI.Process<Triage>()("Triage", {
  description: "Answer one issue of the repository and say what kind of issue it is.",
})`
  You look after one issue of a GitHub repository. Your first message says
  which. The repository is checked out at ~/repo in your sandbox.

  Get the issue with ${Board.IssueDetail}: its key is the issue. Find the
  code it is about with ${AI.Grep} and ${AI.Read}, and look for duplicates
  with ${SearchIssues}. Never change a file.

  Then follow ${Answering} and post your answer with ${PostAnswer}. Last,
  send ${Board.LabelIssue}: bug when something is broken, feature when
  something new is asked for, question otherwise.

  Later messages are replies on the issue. Answer each the same way, and
  send ${Board.LabelIssue} again when a reply changes what kind of issue it is.
`) {}
