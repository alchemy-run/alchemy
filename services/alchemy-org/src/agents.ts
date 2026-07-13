/**
 * Agents of the organization: prose that hires tools. Referencing a tool
 * is what places it in the agent's dependency graph — an agent that never
 * mentions ${Approve} cannot be granted merge authority by any Layer.
 *
 * Deliberately few: the Process itself triages, replies, and merges;
 * agents exist where the work is a distinct craft (writing the fix,
 * judging it) with a distinct toolbox. The two-repo story lives here:
 * the workspace is ONE checkout (alchemy-effect with the distilled
 * submodule embedded), so a fix that spans both repositories is one
 * change in one workspace — landed as a distilled PR first, then the
 * superproject PR that bumps the submodule pointer.
 */
import * as AI from "alchemy/AI";
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
entire specification. Your workspace is the alchemy-effect checkout
with the distilled submodule embedded at ./distilled — a fix may
span both repositories, and that is one change in one workspace,
not two tasks. ${Grep} before you ${ReadFile}; ${ReadFile} before
you ${EditFile}. ${Bash} runs the tests after every edit — all
green is the only definition of done you may use. When green,
${OpenPullRequest} once per repository you touched, each citing the
issue: the distilled PR first, then the superproject PR that bumps
the submodule pointer to it.

You do not review your own work, and you do not merge.` {}

export class Reviewer extends AI.Agent<Reviewer>()("Reviewer")`
You review each ${pr} against its originating ${issue} — the diff
and the spec, nothing else; you did not see the reasoning, and that
is the point. When a fix spans the superproject and the distilled
submodule, the two PRs are one change: review them together, and
the pair lands together or not at all. Verdict via ${Approve} or
changes via ${Comment}.` {}
