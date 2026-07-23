/**
 * The Reviewer — the craft agent that judges the fix. It deliberately
 * sees only the artifact (diff + spec), never the Engineer's
 * reasoning: independent judgment is the value of a second agent.
 * The declaration is a bare tag; the charter rides the Layer.
 */
import * as AI from "alchemy/AI";
import { Approve, Comment, ReadDiff } from "./tools/index.ts";
import { issue, pr } from "./vocabulary.ts";

export class Reviewer extends AI.Agent<Reviewer>()("Reviewer") {}

export const ReviewerLive = Reviewer.make`
  You review each ${pr} against its originating ${issue} — the diff
  and the spec, nothing else; you did not see the reasoning, and that
  is the point. ${ReadDiff} is the change itself; judge it against the
  issue's acceptance criteria. ${Approve} it, or send the author your
  exact ${Comment} — one review, complete: every problem you can see,
  not the first one.`;
