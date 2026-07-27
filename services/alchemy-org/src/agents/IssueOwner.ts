/**
 * The issue OWNER — one agent per GitHub issue, accountable for it
 * from open to close. Its run is the issue's whole thread: every
 * event lands in the owner's one conversation, and the WORK is done
 * by the workers the owner dispatches through its doors —
 * ${Engineer} writes the fix, ${Reviewer} judges it — whose results
 * come back as messages in the same context. The world is wired to
 * it by the router in processes/Issues.ts; nothing else addresses it.
 */
import * as AI from "alchemy/AI";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { testAlchemy } from "../Repos.ts";
import {
  CloseIssue,
  Comment,
  LinkIssues,
  MergePullRequest,
  SearchIssues,
} from "../tools/index.ts";
import { Engineer } from "./Engineer.ts";
import { Reviewer } from "./Reviewer.ts";

/** The owner's loop — `IssuesLive` wires the world to it. */
export class IssueOwner extends AI.Agent<IssueOwner>()("IssueOwner") {}

const task = AI.Parameter("task", S.String)`
The work, standing alone — the worker sees only this.`;

/**
 * The DOORS — policy-constrained dispatches (`AI.Dispatch`): the org
 * names the tool, writes its prose, and derives the child key in
 * CODE, so the one-engineer-per-issue invariant is enforced by the
 * absence of any session parameter at the wire; the kernel executes
 * the call (parentage, supervision cascade, worker-card observation).
 *
 * TOPOLOGY IS THE KEY: both doors hand their worker the ISSUE'S OWN
 * key, so the engineer's and the reviewer's runs resolve the SAME
 * checkout through `Workspace.perRun` — the reviewer explores the
 * exact tree the engineer built in and runs its tests. (Isolated
 * workers would be one line: derive distinct keys.) The owner
 * sequences the two through call/reply, so the shared tree is never
 * touched concurrently.
 */
const HandToEngineer = AI.Dispatch(Engineer, "hand_to_engineer")`
  Hand one round of issue work to the engineer, with ${task} standing
  alone: the issue reference (owner, repository, number) and the
  acceptance criteria verbatim on the first round; review feedback
  restated as WORK — what to change, where, which criterion fails —
  on later rounds. It is the same engineer each time, its checkout
  and context intact; it answers with the pull request reference.`(
  (p: { task: string }, thread) => ({
    task: p.task,
    key: thread.key,
  }),
);

const HandToReviewer = AI.Dispatch(Reviewer, "hand_to_reviewer")`
  Hand the pull request to review, with ${task} carrying the pull
  request reference verbatim (owner, repository, number, url) and the
  issue number — a reviewer without the reference can only ask for
  one. The reviewer works in the same checkout the engineer built in;
  re-reviews go through this same door and remember what they already
  judged.`(
  (p: { task: string }, thread) => ({
    task: p.task,
    key: thread.key,
  }),
);

const note = AI.Parameter("note", S.String)`
What your future self needs to know — include context; the situation
may have moved by then.`;

const delay = AI.Parameter("delay", S.String)`
How long from now, e.g. "4 hours" or "1 day".`;

/**
 * The charter: one STATIC system prompt for the issue's whole life —
 * the conversation carries which stage is live. Parking is
 * quiescence (stop calling tools; the kernel parks the run), and the
 * next world event — or a self-set reminder — wakes it. The owner
 * does no craft work itself: the doors dispatch the Engineer and
 * Reviewer, who work in their own threads and answer as messages
 * here.
 */
export const IssueOwnerLive = IssueOwner.make(
  Effect.gen(function* () {
    const handToEngineer = yield* HandToEngineer;
    const handToReviewer = yield* HandToReviewer;

    const remindMe = yield* AI.Tool("remind_me")`
      Note ${note} to your future self, after ${delay}. It arrives as
      an ordinary message — judge it fresh; the situation may have
      moved.`(
      Effect.fn(function* (p: { note: string; delay: string }) {
        const parsed = Duration.fromInput(p.delay as Duration.Input);
        if (Option.isNone(parsed)) {
          // model-visible: a malformed delay is a result to correct
          return yield* Effect.fail(
            `'${p.delay}' is not a duration — use e.g. "4 hours" or "1 day"`,
          );
        }
        const thread = yield* AI.Thread;
        yield* thread.remind(parsed.value, p.note);
        return `noted — you'll hear this again in ${p.delay}`;
      }),
    );

    return AI.prose`
      You own one GitHub issue in ${testAlchemy} from open to close.
      Every event on it arrives here — the issue, its comments, and
      its pull request's lifecycle — and the work is done by the
      workers you dispatch.

      Triage first: check for prior art with ${SearchIssues}. An issue
      already covered by an open one is a duplicate: ${LinkIssues} to
      the original, ${Comment} telling the author where the
      conversation lives, and ${CloseIssue}. A related-but-distinct
      issue is linked and stays open. An issue is READY when its
      acceptance criteria are precise enough that someone who has read
      nothing else could start work; until then, ${Comment} asks the
      author for exactly what is missing, ${remindMe} covers the
      silence (a day is patient enough), and you wait — the reply, or
      your reminder, arrives as the next message.

      A ready issue goes through ${handToEngineer}, which answers with
      the created pull request's reference. The pull request goes
      through ${handToReviewer} for its verdict. Requested changes are
      relayed to the author with ${Comment} in the Reviewer's own
      words — and become the engineer's next round through
      ${handToEngineer}. An approval is followed by
      ${MergePullRequest} — an approved-but-unmerged pull request is
      unfinished work; the merge tool refuses without a recorded
      approval, and a refusal is a fact about the world to fix, not to
      work around. When the refusal says a HUMAN review is pending,
      the wait is the work: ${remindMe} (a few hours is right) and
      retry the merge when you hear back.

      A merged fix closes your issue with ${CloseIssue}, citing the
      pull request; an author confirming the problem is gone does the
      same. An issue is never closed for inactivity alone.`;
  }),
);
