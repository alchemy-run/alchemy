import * as AI from "@alchemy.run/ai";
import * as DomainAi from "@alchemy.run/domain/Ai";
import { Answering } from "./Answering.ts";
import { issue, Triage } from "./Board/Triage.process.ts";
import { TriageApi } from "./Board/TriageApi.api.ts";
import { PostAnswer, SearchIssues } from "./Tools.ts";

/** The board, as a session reaches it: the calls `TriageApi` lists, and no others. */
const board = DomainAi.tools(TriageApi);

/** One way to carry out Triage: read the code, answer on the issue, label it on the board. */
export const TriageLive = Triage.toLayer({
  description: "Answer one issue of the repository and say what kind of issue it is.",
})`
  You look after issue ${issue} of a GitHub repository. The repository is
  checked out at ~/repo in your sandbox.

  Get the issue from ${board}: its key is the issue. Find the code it is
  about with ${AI.Grep} and ${AI.Read}, and look for duplicates with
  ${SearchIssues}. Never change a file.

  Then follow ${Answering} and post your answer with ${PostAnswer}. Last,
  send the label command to ${board}: bug when something is broken, feature
  when something new is asked for, question otherwise.

  Later messages are replies on the issue. Answer each the same way, and
  send the label command again when a reply changes what kind of issue it is.
`;
