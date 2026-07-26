/**
 * The issue CHANNEL — one agent per GitHub issue that represents the
 * issue's whole thread: every event on it (the issue opening, its
 * comments, its pull request's lifecycle) lands in the channel's one
 * conversation, and the WORK is done by the agents the channel
 * dispatches — ${Engineer} writes the fix, ${Reviewer} judges it —
 * whose results come back as messages in the same context. The
 * experience is a channel with multiple agents sharing one thread;
 * the delegation edges (kernel parentage) let an observer drill into
 * any worker's own transcript.
 *
 * ROUTING is code, not charter: {@link IssuesLive} consumes the
 * repository's events and addresses the channel by issue number. A
 * pull request's events reach the channel through the Ledger's
 * RECORDED link (born structured in OpenPullRequest); the only parse
 * is the boundary case — a human contributor's PR, whose body's
 * "Closes #N" is read once and recorded. Unlinked PRs are handed to
 * the standalone {@link PullRequestReviewer} desk.
 *
 * SEALED in practice: {@link Issues} is a plain `Context.Service`
 * resolving to {@link IssuesService} — the read-only status surface.
 * The channel agent is wired only by {@link IssuesLive}; work enters
 * through GitHub or not at all.
 */
import * as AI from "alchemy/AI";
import * as GitHub from "alchemy/GitHub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Engineer } from "./Engineer.ts";
import { Ledger } from "./Ledger.ts";
import { PullRequestReviewer } from "./PullRequests.ts";
import { prLinkKey, testAlchemy } from "./Repos.ts";
import { Reviewer } from "./Reviewer.ts";
import {
  CloseIssue,
  Comment,
  LinkIssues,
  MergePullRequest,
  SearchIssues,
} from "./tools/index.ts";

/** What the org may ask of the Issues owner from code: read, never drive. */
export interface IssuesService {
  /** Snapshot of the repository's open issues. */
  readonly list: () => Effect.Effect<
    GitHub.ListIssuesResponse,
    GitHub.GitHubApiError
  >;
}

export class Issues extends Context.Service<Issues, IssuesService>()(
  "alchemy-org/Issues",
) {}

/** BOUNDARY parse for pull requests the org did not open (GitHub's
 * own "Closes #N" convention) — read once, then recorded. */
const linkFromBody = (body: string | null | undefined): number | undefined => {
  if (typeof body !== "string") return undefined;
  const match = body.match(/(?:close[sd]?|fixe?[sd]?|resolve[sd]?)\s+#(\d+)/i);
  return match ? Number(match[1]) : undefined;
};

/**
 * The router: ALL repository events arrive here and are addressed to
 * the channel of the issue they concern — `send(event, { key })` is
 * the one delivery verb (the kernel admits on first sight of a key
 * and enqueues thereafter); the world closing the issue is `settle`.
 * The Ledger dedupes DELIVERIES by content; it never gates admission.
 */
export const IssuesLive = Layer.effect(
  Issues,
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const listIssues = yield* GitHub.ListIssues(testAlchemy);
    const getPullRequest = yield* GitHub.GetPullRequest(testAlchemy);
    const channel = yield* IssueChannel;
    const unlinkedDesk = yield* PullRequestReviewer;

    /**
     * The issue a PR's events belong to: the RECORDED link first; a
     * foreign PR falls through to the boundary parse (fetching the
     * body when the event doesn't carry it) and is recorded so the
     * inference happens at most once.
     */
    const issueOf = (
      repo: string,
      pr: number,
      body?: string | null,
    ): Effect.Effect<number | undefined> =>
      Effect.gen(function* () {
        const recorded = yield* ledger.get(prLinkKey(repo, pr));
        if (typeof recorded === "number") return recorded;
        const text =
          body !== undefined
            ? body
            : yield* getPullRequest({ pull_number: pr }).pipe(
                Effect.map((pull) => pull.body),
                Effect.catch(() => Effect.succeed(null)),
              );
        const parsed = linkFromBody(text);
        if (parsed !== undefined) {
          yield* ledger.put(prLinkKey(repo, pr), parsed);
        }
        return parsed;
      });

    yield* GitHub.consumeRepositoryEvents(
      testAlchemy,
      {
        events: [
          GitHub.IssueOpened,
          GitHub.IssueCommented,
          GitHub.IssueClosed,
          GitHub.PullRequestOpened,
          GitHub.PullRequestMerged,
          GitHub.PullRequestClosed,
        ],
      },
      (event) =>
        Effect.gen(function* () {
          const { status } = yield* ledger.offer(
            "issues",
            JSON.stringify(event), // delivery identity: the content itself
            event,
          );
          if (status === "duplicate") return;
          const repo = `${event.repository.owner.login}/${event.repository.name}`;

          switch (event._tag) {
            case "IssueOpened":
              return yield* channel.send(event, {
                key: `${repo}#${event.issue.number}`,
              });
            case "IssueClosed":
              return yield* channel.settle(
                `${repo}#${event.issue.number}`,
                event,
              );
            case "IssueCommented": {
              // GitHub's one comment door serves both thread kinds — a
              // comment on a PULL REQUEST belongs to the PR's issue
              if (!GitHub.isPullRequestComment(event)) {
                return yield* channel.send(event, {
                  key: `${repo}#${event.issue.number}`,
                });
              }
              const linked = yield* issueOf(repo, event.issue.number);
              return linked !== undefined
                ? yield* channel.send(event, { key: `${repo}#${linked}` })
                : yield* unlinkedDesk.send(event, {
                    key: `${repo}#${event.issue.number}`,
                  });
            }
            case "PullRequestOpened":
            case "PullRequestMerged":
            case "PullRequestClosed": {
              const pr = event.pullRequest.number;
              const linked = yield* issueOf(repo, pr, event.pullRequest.body);
              if (linked !== undefined) {
                // the channel hears its PR's whole lifecycle as messages
                return yield* channel.send(event, {
                  key: `${repo}#${linked}`,
                });
              }
              // foreign, unlinked: the standalone review desk owns it
              return event._tag === "PullRequestOpened"
                ? yield* unlinkedDesk.send(event, { key: `${repo}#${pr}` })
                : yield* unlinkedDesk.settle(`${repo}#${pr}`, event);
            }
          }
        }),
    );

    return {
      list: () => listIssues({ state: "open" }),
    };
  }),
).pipe(Layer.provide(Layer.suspend(() => IssueChannelLive)));
// (PullRequestReviewerLive is provided by the entrypoint — the desk is
// shared with the /api/status surface's owner, never private to the router)

/** The channel's loop — {@link IssuesLive} wires the world to it. */
export class IssueChannel extends AI.Agent<IssueChannel>()("Channel") {}

/**
 * The charter: one STATIC system prompt for the issue's whole life —
 * the conversation carries which stage is live. Parking is
 * quiescence (stop calling tools; the kernel parks the run), and the
 * next world event wakes it. The channel does no craft work itself:
 * ${Engineer} and ${Reviewer} are dispatched, work in their own
 * threads, and return their results as messages here.
 */
export const IssueChannelLive = IssueChannel.make`
  This channel owns one GitHub issue in ${testAlchemy} from open to
  close. Every event on it arrives here — the issue, its comments,
  and its pull request's lifecycle — and the work is done by the
  agents this channel dispatches.

  Triage first: check for prior art with ${SearchIssues}. An issue
  already covered by an open one is a duplicate: ${LinkIssues} to the
  original, ${Comment} telling the author where the conversation
  lives, and ${CloseIssue}. A related-but-distinct issue is linked
  and stays open. An issue is READY when its acceptance criteria are
  precise enough that someone who has read nothing else could start
  work; until then, ${Comment} asks the author for exactly what is
  missing and this channel waits — the reply arrives as the next
  message.

  A ready issue goes to ${Engineer} — always in session "build", so
  the whole back-and-forth is ONE engineer with its checkout and
  context intact across rounds. The Engineer sees only what its task
  says: the first task carries the issue reference (owner,
  repository, number) and the acceptance criteria verbatim, and it
  returns the created pull request's reference. When review feedback
  needs fixing, dispatch session "build" again with the feedback —
  the same engineer fixes its own work on the same branch.

  ${Reviewer} judges the pull request against the issue — always in
  session "review", so a re-review remembers what it already judged.
  The Reviewer sees only what its task says: hand it the pull request
  reference verbatim (and the issue number) — a reviewer without the
  reference can only ask for one. An approval is followed by
  ${MergePullRequest} — an approved-but-unmerged pull request is
  unfinished work; the merge tool refuses without a recorded
  approval, and a refusal is a fact about the world to fix, not to
  work around. Requested changes are relayed to the author with
  ${Comment} in the Reviewer's own words.

  A merged fix closes this issue with ${CloseIssue}, citing the pull
  request; an author confirming the problem is gone does the same. An
  issue is never closed for inactivity alone.`;
