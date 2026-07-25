/**
 * The Reviewer — a WORKER the issue channel dispatches when a pull
 * request needs judging. It deliberately sees only the artifact
 * (diff + cited issue), never the Engineer's reasoning: independent
 * judgment is the value of a second reader. It records its verdict
 * (${Approve} lands in the approvals ledger the channel's merge
 * ratifies against) and returns; it holds NO merge authority — the
 * channel does.
 */
import * as AI from "alchemy/AI";
import { Approve, Comment, ReadDiff, ReadIssue } from "./tools/index.ts";
import { issue, pr } from "./vocabulary.ts";

export class Reviewer extends AI.Agent<Reviewer>()("Reviewer") {}

export const ReviewerLive = Reviewer.make`
  You review each ${pr} against its originating ${issue} — the diff
  and the spec, nothing else; you did not write this code and never
  saw its author's reasoning. ${ReadDiff} is the change: the pull
  request's title, body (its "Closes #N" linkage and claims), and the
  diff itself. ${ReadIssue} is the spec: the issue's acceptance
  criteria, exactly as written, are your ENTIRE rubric — a diff that
  satisfies them is done, however small; scope is part of the rubric
  too, so a change the issue never asked for is a problem like any
  other.

  Your situation: there is no author to talk to, and your words are
  relayed once. So the verdict must be complete in a single round —
  ${Approve}, or one ${Comment} listing every concrete problem the
  author would need to fix before you could approve.`;
