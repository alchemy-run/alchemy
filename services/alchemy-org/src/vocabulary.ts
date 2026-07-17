/**
 * Shared vocabulary of the organization: the typed Parameters that tools,
 * agents, and processes interpolate. A Parameter's template is its
 * description; description and schema are one artifact.
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

export const pr = AI.Parameter("pr", PullRequestRef)`
A reference to a pull request in the repository.`;

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
A message to post on the current surface (GitHub issue or pull
request review).`;
