/**
 * The Issues process — the ROUTER that wires GitHub to the issue
 * channels. Routing is code, not charter: {@link IssuesLive} consumes
 * the repository's events and addresses the {@link IssueOwner}
 * agent (agents/IssueOwner.ts) by issue number — one run per issue,
 * the issue's whole thread. A pull request's events reach the owner
 * through the Ledger's RECORDED link (born structured in
 * OpenPullRequest); the only parse is the boundary case — a human
 * contributor's PR, whose body's "Closes #N" is read once and
 * recorded. Unlinked PRs are handed to the standalone
 * {@link PullRequestReviewer} desk.
 *
 * SEALED in practice: {@link Issues} is a plain `Context.Service`
 * resolving to {@link IssuesService} — the read-only status surface.
 * The channel agent is wired only by {@link IssuesLive}; work enters
 * through GitHub or not at all.
 */
import * as GitHub from "alchemy/GitHub";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { IssueOwner, IssueOwnerLive } from "../agents/IssueOwner.ts";
import { PullRequestReviewer } from "../agents/Reviewer.ts";
import { Ledger } from "../Ledger.ts";
import { prLinkKey, testAlchemy } from "../Repos.ts";

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
 * the owner of the issue they concern — `send(event, { key })` is
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
    const channel = yield* IssueOwner;
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
                // the owner hears its PR's whole lifecycle as messages
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
).pipe(Layer.provide(Layer.suspend(() => IssueOwnerLive)));
// (PullRequestReviewerLive is provided by the entrypoint — the desk is
// shared with the /api/status surface's owner, never private to the router)
