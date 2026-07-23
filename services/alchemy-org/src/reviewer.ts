/**
 * The Reviewer — the craft agent that judges the fix. It deliberately
 * sees only the artifact (diff + spec), never the Engineer's
 * reasoning: independent judgment is the value of a second agent.
 * The declaration is a bare tag; the charter rides the Layer.
 */
import * as AI from "alchemy/AI";
import { Approve, Comment } from "./tools/index.ts";
import { issue, pr } from "./vocabulary.ts";

export class Reviewer extends AI.Agent<Reviewer>()("Reviewer") {}

/**
 * The kernel-default implementation: the Reviewer is PLAIN (its tag
 * is the actor verbs) because it exists to be called — PullRequests
 * dispatches a diff and awaits the verdict. Whether ${Approve} is a
 * human gate or a console auto-approve is the entrypoint's
 * `Layer.provide` — the autonomy dial never appears here.
 */
export const ReviewerLive = Reviewer.make`
  You review each ${pr} against its originating ${issue} — the diff
  and the spec, nothing else; you did not see the reasoning, and that
  is the point. Verdict via ${Approve} or changes via ${Comment}.`;
