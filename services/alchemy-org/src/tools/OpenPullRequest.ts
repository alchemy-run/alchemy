import * as AI from "alchemy/AI";
import * as S from "effect/Schema";
import { body, IssueRef, title } from "../Vocabulary.ts";

const resolves = AI.Parameter("issue", S.optionalKey(IssueRef))`
The issue this pull request resolves, when there is one — the branch
name, commit message, and the recorded PR→issue link derive from it.
Omit for pull requests that resolve no issue (a scheduled maintenance
pass).`;

export class OpenPullRequest extends AI.Tool<OpenPullRequest>()(
  "openPullRequest",
)`
Open a pull request from the work in the workspace: commits
everything to a branch, pushes it, and opens the PR with ${title} and
${body}, optionally resolving ${resolves}. Returns the created pull
request reference.` {}

/** The bot's commit identity — visible in the sandbox repo's history. */
export const GIT_IDENTITY = [
  "-c",
  "user.name=alchemy-org[bot]",
  "-c",
  "user.email=bot@alchemy.run",
] as const;
