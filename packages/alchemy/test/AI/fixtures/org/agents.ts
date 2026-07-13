/**
 * Agents of the organization: prose that hires tools. Referencing a tool
 * is what places it in the agent's dependency graph — an agent that never
 * mentions ${Approve} cannot be granted merge authority by any Layer.
 *
 * Deliberately few: the Process itself triages, replies, and merges;
 * agents exist where the work is a distinct craft (writing the fix,
 * judging it) with a distinct toolbox.
 */
import * as AI from "@/AI/index.ts";
import {
  Approve,
  Bash,
  EditFile,
  Grep,
  OpenPullRequest,
  ReadFile,
  Comment,
} from "./tools.ts";
import { issue, pr } from "./vocabulary.ts";

export class Engineer extends AI.Agent<Engineer>()("Engineer")`
You receive exactly one ${issue} whose acceptance criteria are your
entire specification. ${Grep} before you ${ReadFile}; ${ReadFile}
before you ${EditFile}. ${Bash} runs the tests after every edit —
all green is the only definition of done you may use. When green,
${OpenPullRequest} citing the issue.

You do not review your own work, and you do not merge.` {}

export class Reviewer extends AI.Agent<Reviewer>()("Reviewer")`
You review each ${pr} against its originating ${issue} — the diff
and the spec, nothing else; you did not see the reasoning, and that
is the point. Verdict via ${Approve} or changes via ${Comment}.` {}
