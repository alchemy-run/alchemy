/**
 * The Issues process — the ROUTER that wires GitHub to the issue
 * channels. Routing is code, not charter: {@link IssuesLive} consumes
 * the repository's events and addresses the {@link IssueOwner}
 * agent (agents/IssueOwner.ts) by issue number — one run per issue,
 * the issue's whole thread. A pull request's events reach the owner
 * through the Ledger's RECORDED link (born structured in
 * OpenPullRequest); the only parse is the boundary case — a human
 * contributor's PR, whose body's "Closes #N" is read once and
 * recorded. Unlinked PRs go to the ONE {@link Reviewer} directly,
 * with a deterministic ratifier attempting the merge on its verdict.
 *
 * SEALED in practice: {@link Issues} is a plain `Context.Service`
 * resolving to {@link IssuesService} — the read-only status surface.
 * The channel agent is wired only by {@link IssuesLive}; work enters
 * through GitHub or not at all.
 */
import * as AI from "alchemy/AI";
import { WorkerExecutionContext } from "alchemy/Cloudflare/Workers";
import * as GitHub from "alchemy/GitHub";
import { makeProcessScope } from "alchemy/Local";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Engineer, type OpenedPullRequest } from "../agents/Engineer.ts";
import { IssueOwner, IssueOwnerLive } from "../agents/IssueOwner.ts";
import { Reviewer } from "../agents/Reviewer.ts";
import { Ledger } from "../services/Ledger.ts";
import { prLinkKey, testAlchemy } from "../Repos.ts";
import { Coding } from "../skills/Coding.ts";
import { MergePullRequest, OpenPullRequest } from "../tools/index.ts";
import { body, issue, title } from "../Vocabulary.ts";

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
    const process = yield* makeProcessScope;
    const ledger = yield* Ledger;
    const listIssues = yield* GitHub.ListIssues(testAlchemy);
    const getPullRequest = yield* GitHub.GetPullRequest(testAlchemy);
    const channel = yield* IssueOwner;
    const reviewer = yield* Reviewer;
    const merge = yield* MergePullRequest;

    /**
     * A foreign (unlinked) pull request has no owner to run its
     * lifecycle, but it gets the same TWO-KEY ceremony: the ONE
     * Reviewer judges it (a dispatch — the same worker every round,
     * keyed by the PR), and this DETERMINISTIC ratifier attempts the
     * merge. The merge tool refuses without a recorded approval, so
     * requested-changes verdicts simply leave the PR open with the
     * review attached. Forked: a review takes minutes and must never
     * stall event delivery.
     */
    const reviewStandalone = (
      key: string,
      event: unknown,
      pull: { readonly number: number; readonly url?: string },
    ) =>
      Effect.gen(function* () {
        yield* reviewer.dispatch(event, { key });
        const identity = yield* GitHub.resolveRepository(testAlchemy);
        yield* merge({
          pr: {
            owner: identity.owner,
            repository: identity.repository,
            number: pull.number,
            url:
              pull.url ??
              `https://github.com/${identity.owner}/${identity.repository}/pull/${pull.number}`,
          },
        }).pipe(
          Effect.catch((refusal) =>
            Effect.logInfo(`standalone PR #${pull.number}: ${refusal}`),
          ),
        );
      }).pipe(
        // the router IS the running host — discharge the runtime color
        // the tool callable carries (the kernel's own pattern)
        Effect.provide(RuntimeContext.phantom),
        background,
      );

    /**
     * Minutes-long work OFF the delivery path — a review must never
     * stall event ingestion. Substrate-aware at the last inch: on a
     * Worker the delivery runs inside a request, whose lifetime
     * `waitUntil` extends (a fiber forked into the BUILD scope would
     * die with the event); locally the process Scope (Host keeper)
     * owns the fiber so `Effect.provide(OrgLocal)` cannot tear it down.
     */
    function background<E>(work: Effect.Effect<void, E>): Effect.Effect<void> {
      return Effect.gen(function* () {
        const ctx = yield* Effect.serviceOption(WorkerExecutionContext);
        if (Option.isSome(ctx)) {
          yield* ctx.value
            .waitUntil(work)
            .pipe(Effect.provide(RuntimeContext.phantom));
        } else {
          yield* process.fork(work.pipe(Effect.orDie, Effect.asVoid));
        }
      });
    }

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
                : // a comment on a foreign PR is a new review round —
                  // same reviewer run, then the ratifier tries again
                  yield* reviewStandalone(
                    `${repo}#${event.issue.number}`,
                    event,
                    { number: event.issue.number },
                  );
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
              // foreign, unlinked: review + deterministic ratification
              return event._tag === "PullRequestOpened"
                ? yield* reviewStandalone(`${repo}#${pr}`, event, {
                    number: pr,
                    url: event.pullRequest.html_url,
                  })
                : yield* reviewer.settle(`${repo}#${pr}`, event);
            }
          }
        }),
    );

    return {
      list: () => listIssues({ state: "open" }),
    };
  }),
).pipe(Layer.provide(Layer.suspend(() => IssueOwnerLive)));
// (ReviewerLive and MergePullRequestLive come from the entrypoint —
// the same reviewer binding and merge physics the owner's door uses)

/**
 * The ISSUE mission for the {@link Engineer} role — defined WITH the
 * desk that staffs it: the entrypoint provides this binding (plus the
 * toolbox physics) to the IssueOwner's subtree, so its ${Engineer} is
 * the issue-flavored one. Which physics answers its tools (local
 * toolbox vs a DevBox container) stays the entrypoint's
 * `Layer.provide`.
 */
export const IssueEngineer = Engineer.make(
  Effect.gen(function* () {
    const open = yield* OpenPullRequest;

    // the mission's OWN wrapper over the shared PR physics: the prose
    // is issue-shaped (cite "Closes #N"), and AI.reply answers the
    // owner's dispatch with the TYPED artifact the moment it exists
    const openPullRequest = yield* AI.Tool("open_pull_request")`
      Open the pull request resolving ${issue}, with ${title} and
      ${body} — the body must cite the issue ("Closes #N") and the
      evidence that its criteria are met. Only call this when the work
      in the workspace is complete. On a fix round, this same call
      pushes to the same branch and updates the open pull request.`(
      Effect.fn(function* (params) {
        const created = (yield* open(params)) as OpenedPullRequest;
        yield* AI.reply(created.pr);
        return created;
      }),
    );

    // the stance is CONSTANT — an `Effect<Fragment>` is a valid turn,
    // so returning the prose directly is the whole loop
    return AI.prose`
      You are an engineer on one issue's thread; each task you receive
      is a round of that work.

      ## Rounds

      - A first ${issue} carries the acceptance criteria — your entire
        specification.
      - Later rounds carry review feedback on the pull request you
        opened.

      ## Workspace

      Your tools operate inside the issue's checkout of the repository
      — paths are repository-relative. The reviewer reads and tests in
      this same checkout; leave it as you would a shared desk.

      ## Craft

      ${Coding} is your craft; done means the criteria are met and the
      tests are green. Then ${openPullRequest}.

      Review and merge are someone else's job.`;
  }),
);
