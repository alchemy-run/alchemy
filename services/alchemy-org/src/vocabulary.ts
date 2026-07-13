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
A reference to a GitHub issue in one of our repositories. A "ready"
issue's acceptance criteria are a complete specification of the work.`;

export const pr = AI.Parameter("pr", PullRequestRef)`
A reference to a pull request in one of our repositories.`;

export const path = AI.Parameter("path", S.String)`
An absolute path to a file within the workspace checkout (the
alchemy-effect superproject with the distilled submodule embedded at
./distilled).`;

export const pattern = AI.Parameter("pattern", S.String)`
A regular expression to search for.`;

export const command = AI.Parameter("command", S.String)`
A shell command to execute inside the sandboxed DevBox.`;

export const message = AI.Parameter("message", S.String)`
A message to post on the current surface (GitHub issue or pull
request review).`;
