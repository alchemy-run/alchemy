/**
 * Shared vocabulary of the organization: the typed Parameters that tools
 * and agents interpolate. A Parameter's template is its description;
 * description and schema are one artifact.
 */
import * as AI from "alchemy/AI";
import * as S from "effect/Schema";

// S.Int, not S.Number: S.Number's JSON schema is a 4-way anyOf
// (number | "NaN" | "Infinity" | "-Infinity") and Anthropic hard-caps
// union-typed parameters per request (16) — a toolkit of refs blows
// through it. Issue/PR numbers are integers anyway.
export const IssueRef = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Int,
});

export const PullRequestRef = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Int,
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
A workspace-relative path to a file within the repository checkout
(e.g. "src/index.ts"). Never absolute, never escaping the workspace.`;

export const content = AI.Parameter("content", S.String)`
The COMPLETE new contents of the file — never a patch or a fragment,
the whole file as it should be on disk.`;

export const pattern = AI.Parameter("pattern", S.String)`
A regular expression (full regex syntax, e.g. "log.*Error" or
"function\\s+\\w+"). Pass the raw pattern with no surrounding
slashes or quotes; escape literal ".", "(", "[" and friends.`;

export const command = AI.Parameter("command", S.String)`
A shell command run with 'sh -c' at the workspace root. Chain steps
with '&&'; quote paths containing spaces.`;

export const message = AI.Parameter("message", S.String)`
A message to post on the current surface (a GitHub issue, a pull
request review, a Discord thread).`;

export const thread = AI.Parameter("thread", S.String)`
The Discord thread the conversation lives in.`;
