/**
 * Shared vocabulary of the organization: the typed Parameters that tools
 * and agents interpolate. A Parameter's template is its description;
 * description and schema are one artifact.
 */
import * as AI from "alchemy/AI";
import * as S from "effect/Schema";

export const IssueRef = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
});

export const PullRequestRef = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
  url: S.String,
});

export const issue = AI.Parameter("issue", IssueRef)`
A reference to a GitHub issue in the repository. A "ready" issue's
acceptance criteria are a complete specification of the work. A pull
request's number addresses it here too — GitHub comments on both
through the same door.`;

export const related = AI.Parameter("related", IssueRef)`
Another issue in the repository that the current one relates to.`;

export const pr = AI.Parameter("pr", PullRequestRef)`
A reference to a pull request in the repository.`;

export const title = AI.Parameter("title", S.String)`
A one-line title: specific enough that a list of fifty of these is
scannable.`;

export const body = AI.Parameter("body", S.String)`
The full markdown body. It must stand alone — the reader has no
access to the conversation that produced it.`;

export const reason = AI.Parameter("reason", S.String)`
Why — citing the evidence (a merged pull request, a confirming
author, the original issue a duplicate points at).`;

export const path = AI.Parameter("path", S.String)`
A workspace-relative path to a file within the repository checkout.`;

export const content = AI.Parameter("content", S.String)`
The complete new contents of the file — always the COMPLETE file,
never a patch.`;

export const pattern = AI.Parameter("pattern", S.String)`
A regular expression to search for.`;

export const command = AI.Parameter("command", S.String)`
A shell command to execute inside the workspace.`;

export const message = AI.Parameter("message", S.String)`
A message to post on the current surface (a GitHub issue, a pull
request review, a Discord thread).`;

export const thread = AI.Parameter("thread", S.String)`
The Discord thread the conversation lives in.`;
