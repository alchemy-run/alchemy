import * as GitHub from "alchemy/GitHub";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { primary, nameOf } from "../github/Repos.ts";
import { Registry, type RegistryEntity } from "./Registry.ts";

/**
 * SYNC — GitHub is the source of truth for entities; the Registry
 * holds snapshots. One full sweep (`syncGitHub`) reconciles every open
 * issue and pull request of the connected repository into the
 * Registry and closes out rows GitHub no longer lists as open; one
 * incremental path (`entityOfEvent`) keeps rows warm from webhook
 * deliveries without an API call.
 */

type Labels = ReadonlyArray<string | { readonly name?: string | null }>;

const labelNames = (labels: Labels | null | undefined): ReadonlyArray<string> =>
  (labels ?? []).flatMap((label) =>
    typeof label === "string"
      ? [label]
      : label.name == null
        ? []
        : [label.name],
  );

const at = (iso: string | null | undefined, fallback: number): number => {
  const parsed = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(parsed) ? fallback : parsed;
};

interface PullLike {
  readonly number: number;
  readonly title: string;
  readonly state?: string | null;
  readonly draft?: boolean | null;
  readonly merged_at?: string | null;
  readonly user?: { readonly login: string } | null;
  readonly labels?: Labels | null;
  readonly head?: { readonly ref?: string | null } | null;
  readonly base?: { readonly ref?: string | null } | null;
  readonly updated_at?: string | null;
}

interface IssueLike {
  readonly number: number;
  readonly title: string;
  readonly state?: string | null;
  readonly state_reason?: string | null;
  readonly user?: { readonly login: string } | null;
  readonly labels?: Labels | null;
  readonly updated_at?: string | null;
  readonly pull_request?: unknown;
}

const pullEntity = (
  repo: string,
  pull: PullLike,
  now: number,
): Omit<RegistryEntity, "syncedAt"> => ({
  ref: `${repo}#${pull.number}`,
  kind: "pull",
  state:
    pull.merged_at != null
      ? "merged"
      : pull.state === "closed"
        ? "closed"
        : pull.draft === true
          ? "draft"
          : "open",
  title: pull.title,
  ...(pull.user == null ? {} : { author: pull.user.login }),
  labels: labelNames(pull.labels),
  ...(pull.head?.ref == null ? {} : { headRef: pull.head.ref }),
  ...(pull.base?.ref == null ? {} : { baseRef: pull.base.ref }),
  updatedAt: at(pull.updated_at, now),
});

const issueEntity = (
  repo: string,
  issue: IssueLike,
  now: number,
): Omit<RegistryEntity, "syncedAt"> => ({
  ref: `${repo}#${issue.number}`,
  kind: "issue",
  state: issue.state === "closed" ? "closed" : "open",
  title: issue.title,
  ...(issue.user == null ? {} : { author: issue.user.login }),
  labels: labelNames(issue.labels),
  updatedAt: at(issue.updated_at, now),
});

/**
 * A webhook delivery's entity snapshot, when the event carries one —
 * the incremental sync path (no API call). Push events carry none.
 */
export const entityOfEvent = (
  event: GitHub.RepositoryEvent,
  now: number,
): Omit<RegistryEntity, "syncedAt"> | undefined => {
  const repo = `${event.repository.owner.login}/${event.repository.name}`;
  switch (event._tag) {
    case "IssueOpened":
    case "IssueLabeled":
    case "IssueClosed":
      return {
        ...issueEntity(repo, event.issue as IssueLike, now),
        state: event._tag === "IssueClosed" ? "closed" : "open",
      };
    case "IssueCommented":
      return issueEntity(repo, event.issue as IssueLike, now);
    case "PullRequestOpened":
    case "PullRequestSynchronized":
      return pullEntity(repo, event.pullRequest as PullLike, now);
    case "PullRequestMerged":
      return { ...pullEntity(repo, event.pullRequest as PullLike, now), state: "merged" };
    case "PullRequestClosed":
      return { ...pullEntity(repo, event.pullRequest as PullLike, now), state: "closed" };
    case "Push":
      return undefined;
  }
};

/**
 * Build the full sweep: list every open pull and issue of the
 * connected repository, upsert them, and close out Registry rows
 * GitHub no longer lists as open. Answers the counts.
 */
export const makeSyncGitHub = Effect.gen(function* () {
  const registry = yield* Registry;
  const listPullRequests = yield* GitHub.ListPullRequests(primary);
  const listIssues = yield* GitHub.ListIssues(primary);
  const repo = nameOf(primary);

  return Effect.fn(function* () {
    const now = yield* Clock.currentTimeMillis;
    const [pulls, issues] = yield* Effect.all(
      [
        listPullRequests({ state: "open", per_page: 100 }),
        listIssues({ state: "open", per_page: 100 }),
      ] as const,
      { concurrency: 2 },
    );
    const open = [
      ...pulls.map((pull) => pullEntity(repo, pull as PullLike, now)),
      ...issues
        .filter((issue) => (issue as IssueLike).pull_request == null)
        .map((issue) => issueEntity(repo, issue as IssueLike, now)),
    ];
    yield* registry.upsertEntities(open);
    // rows we hold as open that GitHub no longer lists: closed out
    // (kept, state flipped — history stays queryable)
    const openRefs = new Set(open.map((entity) => entity.ref));
    const stale = (yield* registry.queryEntities({ state: "open" })).filter(
      (entity) => !openRefs.has(entity.ref),
    );
    const staleDrafts = (
      yield* registry.queryEntities({ state: "draft" })
    ).filter((entity) => !openRefs.has(entity.ref));
    yield* registry.upsertEntities(
      [...stale, ...staleDrafts].map((entity) => ({
        ...entity,
        state: "closed" as const,
      })),
    );
    return {
      pulls: pulls.length,
      issues: open.length - pulls.length,
      closedOut: stale.length + staleDrafts.length,
    };
  });
});
