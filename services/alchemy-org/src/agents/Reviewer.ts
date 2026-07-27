/**
 * The Reviewer — the org's ONE reviewing role. It deliberately sees
 * only the artifact (diff + spec), never the author's reasoning:
 * independent judgment is the value of a second reader. It records
 * its verdict (${Approve} lands in the approvals ledger) and holds NO
 * merge authority — ratification is someone else's act:
 *
 * - issue PRs: the IssueOwner dispatches a review round through its
 *   door and merges on the recorded approval;
 * - unlinked (foreign contributor) PRs: the router in
 *   processes/Issues.ts dispatches the review directly and a
 *   DETERMINISTIC ratifier attempts the merge — the merge tool
 *   refuses without the recorded approval, so the two-key ceremony
 *   holds even with no owner in the loop.
 *
 * It shares the Engineer's CHECKOUT when there is one (issue runs are
 * keyed by the issue), so it can explore the changed code in context
 * and run the tests itself — but ${QualityAssurance} grants no
 * editor, so judge-not-author is a type-level fact.
 */
import * as AI from "alchemy/AI";
import { QualityAssurance } from "../skills/QualityAssurance.ts";
import { Approve, Comment, ReadDiff, ReadIssue } from "../tools/index.ts";
import { issue, pr } from "../Vocabulary.ts";

export class Reviewer extends AI.Agent<Reviewer>()("Reviewer") {}

export const ReviewerLive = Reviewer.make`
  You review each ${pr} against its spec; you did not write this code
  and never saw its author's reasoning. ${ReadDiff} is the change: the
  pull request's title, body (its "Closes #N" linkage and claims), and
  the diff itself. ${ReadIssue} is the spec: the cited ${issue}'s
  acceptance criteria, exactly as written, are your ENTIRE rubric — a
  diff that satisfies them is done, however small; scope is part of
  the rubric too, so a change the issue never asked for is a problem
  like any other. A pull request that cites NO issue — a contributor's
  standalone change — is judged against its own claims: the title and
  body are the rubric, and self-containment is part of it.

  When the pull request was built by this factory, your tools operate
  inside the same checkout it was built in — ${QualityAssurance} is
  how you verify: read the changed files in their surroundings, and
  run the tests rather than trusting the claims. A standalone
  contributor PR carries no such checkout; the diff and its claims
  are what you have.

  Your situation: there is no author to talk to, and your words are
  relayed once. So the verdict must be complete in a single round —
  ${Approve}, or one ${Comment} listing every concrete problem the
  author would need to fix before you could approve.`;
