/**
 * The GitHub event catalog — **world-owned** {@link Event}s scoped
 * to a repository (canon §2a rulings 4 + 6).
 *
 * Provider catalogs are repository-*generic*; charters consume *this*
 * repository's events. The constructors here are scoped: each takes a
 * repository and returns an `Event` **instance** — pure
 * vocabulary: a deterministic name, the typed payload schema (what
 * `AI.when` types `In` with), the rendered clause, and the correlation
 * `key`. Nothing subscribes through it and nothing provisions from it —
 * delivery is user-space code (`consumeRepositoryEvents` + `Match.tag`
 * → `send`/`steer`/`settle` in the process's implementation Layer,
 * whose OWN requirement on `GitHub.RepositoryEventSource` is the
 * compile fence obligating the deployment to provision the wire).
 *
 * Every source is marked `owner: "world"`: GitHub publishes these, a
 * process never can, so a bare `${GitHub.IssueOpened(repo)}` mention is
 * inert vocabulary (renders the name, grants nothing) — only the marked
 * signature expressions (`AI.when` / `AI.exit`) put them to work, and
 * `ctx.emit` of one is a defect.
 *
 * The payload schemas here ARE the typed wire events
 * ({@link RepositoryEvent}) — a charter's `AI.when` types `In` as
 * exactly what the delivery handler routes.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { Event } from "../AI/Event.ts";
import type { Repository } from "./Repository.ts";
import type { WebhookEvent } from "./RepositoryEventSource.ts";
import {
  isRepositoryResource,
  type RepositoryLike,
  repositoryIdentity,
} from "./RepositoryLike.ts";

/**
 * A repository as a source constructor sees it after normalization:
 * plain identity when statically known, the deferred constructor Effect
 * otherwise (identity then only exists in-Effect — the clauses fall
 * back to generic phrasing).
 */
type RepoScope =
  | { owner: string; repository: string }
  | Effect.Effect<Repository, any, any>;

/**
 * Stable per-module-load identity for a DEFERRED constructor whose
 * identity props aren't plain strings (an `Input` owner/name): the
 * source's display name gets a placeholder keyed on the Effect
 * **object** — the same exported const always maps to the same `N`.
 */
const deferredIds = new WeakMap<object, number>();
let nextDeferredId = 0;
const deferredKey = (repo: object): string => {
  let id = deferredIds.get(repo);
  if (id === undefined) {
    id = ++nextDeferredId;
    deferredIds.set(repo, id);
  }
  return `@deferred:${id}`;
};

/**
 * A source's deterministic identity suffix — a plain string at
 * construction time (module scope; no Output resolution):
 *
 * - yielded resource → its `FQN` (namespace path + logical ID) — the
 *   resource's *stable logical identity*, unchanged by a repository
 *   rename (a rename converges in place; the FQN names the declaration,
 *   not the current cloud name);
 * - deferred constructor Effect → `owner/repository` read from its
 *   static {@link repositoryIdentity}; `@deferred:N` only when the
 *   identity props are unresolved `Input`s (stable per module load).
 *
 * The name is DISPLAY/topology identity only — the **wire identity**
 * (which repo to consume) lives in user space, on the
 * `consumeRepositoryEvents` call the implementation Layer makes.
 */
const scopeKey = (repo: RepositoryLike): string => {
  if (isRepositoryResource(repo)) return repo.FQN;
  const identity = repositoryIdentity(repo);
  return identity === undefined
    ? deferredKey(repo)
    : `${identity.owner}/${identity.repository}`;
};

/**
 * Normalize a scoped constructor's repository argument: forms with
 * statically-known identity (a yielded resource's props, a deferred
 * constructor's meta) collapse to the plain identity eagerly; a
 * deferred constructor with unresolved identity props stays an Effect
 * (its clauses use generic phrasing).
 */
const normalizeRepo = (repo: RepositoryLike): RepoScope => {
  const identity = repositoryIdentity(repo);
  if (identity !== undefined) return identity;
  if (Effect.isEffect(repo)) return repo;
  throw new Error(
    `GitHub event sources need the repository's identity as plain strings at construction time, but ${repo.FQN} was declared with unresolved owner/name inputs`,
  );
};

/**
 * The repository as it reads in a source's rendered clause (its
 * `description` — the combinator contract): statically-known identity
 * names the repo (`owner/repository`); a deferred form with unresolved
 * identity can't know the strings at construction, so its clauses use
 * the generic "the repository" — still a full, readable clause.
 */
const describeRepo = (scope: RepoScope): string =>
  Effect.isEffect(scope)
    ? "the repository"
    : `${scope.owner}/${scope.repository}`;

/**
 * The Event `key` contract over the typed events: {@link eventKey}
 * guarded for non-event values (a plain-string demo work item) —
 * consumers fall back to their keyless behavior on `undefined`.
 */
const identityKey = (value: unknown): string | undefined => {
  try {
    return eventKey(value as RepositoryEvent);
  } catch {
    return undefined;
  }
};

// ─── the typed wire: tagged repository events ──────────────────────
//
// `consumeRepositoryEvents` delivers THESE — a tagged union routing
// code matches on (`Match.tag("IssueOpened", …)`), never raw webhook
// payloads. The entity objects (`issue`, `comment`, `pullRequest`,
// `repository`) are the wire's OWN objects passed through by reference
// — every delivered field survives at runtime; the interfaces type the
// principal fields (which is also what a charter's `AI.when` types as
// the process's `In`).
//
// Each event is ONE name declared twice — a NAMED interface (so
// signatures and hovers read `IssueClosedEvent`, never a structural
// expansion) merged with the schema const of the same name (what the
// scoped source constructors carry). The interfaces are the source of
// truth for the payload types; the schema consts are annotated with
// them, so the two can never drift.

export interface Actor {
  readonly login: string;
}

export interface RepositoryInfo {
  /** Repository name (`alchemy-effect`). */
  readonly name: string;
  readonly owner: Actor;
}

export interface Label {
  readonly name: string;
}

/** The principal fields of an issue as delivered by the wire. */
export interface Issue {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state?: string;
  readonly html_url?: string;
  readonly user?: Actor | null;
  readonly labels?: ReadonlyArray<Label>;
  readonly created_at?: string;
  readonly closed_at?: string | null;
}

/** The principal fields of an issue comment as delivered by the wire. */
export interface IssueComment {
  readonly body: string;
  readonly user?: Actor | null;
  readonly html_url?: string;
  readonly created_at?: string;
}

/** The principal fields of a pull request as delivered by the wire. */
export interface PullRequest {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly state?: string;
  readonly html_url?: string;
  readonly user?: Actor | null;
  readonly merged?: boolean;
  readonly merge_commit_sha?: string | null;
  readonly head?: { readonly ref: string };
  readonly base?: { readonly ref: string };
}

export interface Commit {
  readonly id: string;
  readonly message: string;
}

const ActorSchema = S.Struct({ login: S.String });

const RepositoryInfoSchema = S.Struct({
  name: S.String,
  owner: ActorSchema,
});

const LabelSchema = S.Struct({ name: S.String });

const IssueSchema = S.Struct({
  number: S.Number,
  title: S.String,
  body: S.optionalKey(S.NullOr(S.String)),
  state: S.optionalKey(S.String),
  html_url: S.optionalKey(S.String),
  user: S.optionalKey(S.NullOr(ActorSchema)),
  labels: S.optionalKey(S.Array(LabelSchema)),
  created_at: S.optionalKey(S.String),
  closed_at: S.optionalKey(S.NullOr(S.String)),
});

const IssueCommentSchema = S.Struct({
  body: S.String,
  user: S.optionalKey(S.NullOr(ActorSchema)),
  html_url: S.optionalKey(S.String),
  created_at: S.optionalKey(S.String),
});

const PullRequestSchema = S.Struct({
  number: S.Number,
  title: S.String,
  body: S.optionalKey(S.NullOr(S.String)),
  state: S.optionalKey(S.String),
  html_url: S.optionalKey(S.String),
  user: S.optionalKey(S.NullOr(ActorSchema)),
  merged: S.optionalKey(S.Boolean),
  merge_commit_sha: S.optionalKey(S.NullOr(S.String)),
  head: S.optionalKey(S.Struct({ ref: S.String })),
  base: S.optionalKey(S.Struct({ ref: S.String })),
});

const CommitSchema = S.Struct({
  id: S.String,
  message: S.String,
});

/**
 * The schema shape an event const carries: a real schema whose `Type`
 * is the event's NAMED interface — exactly what `AI.Event`
 * requires, without leaking the structural struct type into hovers.
 */
type EventSchema<T> = S.Top & { readonly Type: T };

export interface IssueOpenedEvent {
  readonly _tag: "IssueOpened";
  readonly repository: RepositoryInfo;
  readonly issue: Issue;
}
export const IssueOpenedEvent: EventSchema<IssueOpenedEvent> = S.TaggedStruct(
  "IssueOpened",
  { repository: RepositoryInfoSchema, issue: IssueSchema },
);

export interface IssueLabeledEvent {
  readonly _tag: "IssueLabeled";
  readonly repository: RepositoryInfo;
  readonly issue: Issue;
  readonly label: Label;
}
export const IssueLabeledEvent: EventSchema<IssueLabeledEvent> = S.TaggedStruct(
  "IssueLabeled",
  {
    repository: RepositoryInfoSchema,
    issue: IssueSchema,
    label: LabelSchema,
  },
);

export interface IssueCommentedEvent {
  readonly _tag: "IssueCommented";
  readonly repository: RepositoryInfo;
  readonly issue: Issue;
  readonly comment: IssueComment;
}
export const IssueCommentedEvent: EventSchema<IssueCommentedEvent> =
  S.TaggedStruct("IssueCommented", {
    repository: RepositoryInfoSchema,
    issue: IssueSchema,
    comment: IssueCommentSchema,
  });

export interface IssueClosedEvent {
  readonly _tag: "IssueClosed";
  readonly repository: RepositoryInfo;
  readonly issue: Issue;
}
export const IssueClosedEvent: EventSchema<IssueClosedEvent> = S.TaggedStruct(
  "IssueClosed",
  { repository: RepositoryInfoSchema, issue: IssueSchema },
);

export interface PullRequestOpenedEvent {
  readonly _tag: "PullRequestOpened";
  readonly repository: RepositoryInfo;
  readonly pullRequest: PullRequest;
}
export const PullRequestOpenedEvent: EventSchema<PullRequestOpenedEvent> =
  S.TaggedStruct("PullRequestOpened", {
    repository: RepositoryInfoSchema,
    pullRequest: PullRequestSchema,
  });

export interface PullRequestMergedEvent {
  readonly _tag: "PullRequestMerged";
  readonly repository: RepositoryInfo;
  readonly pullRequest: PullRequest;
}
export const PullRequestMergedEvent: EventSchema<PullRequestMergedEvent> =
  S.TaggedStruct("PullRequestMerged", {
    repository: RepositoryInfoSchema,
    pullRequest: PullRequestSchema,
  });

/** A pull request closed WITHOUT merging (merges are {@link PullRequestMergedEvent}). */
export interface PullRequestClosedEvent {
  readonly _tag: "PullRequestClosed";
  readonly repository: RepositoryInfo;
  readonly pullRequest: PullRequest;
}
export const PullRequestClosedEvent: EventSchema<PullRequestClosedEvent> =
  S.TaggedStruct("PullRequestClosed", {
    repository: RepositoryInfoSchema,
    pullRequest: PullRequestSchema,
  });

export interface PushEvent {
  readonly _tag: "Push";
  readonly repository: RepositoryInfo;
  /** The full git ref (`refs/heads/main`). */
  readonly ref: string;
  /** The branch name (`main`), derived from `ref`. */
  readonly branch: string;
  readonly headCommit: Commit | null;
}
export const PushEvent: EventSchema<PushEvent> = S.TaggedStruct("Push", {
  repository: RepositoryInfoSchema,
  ref: S.String,
  branch: S.String,
  headCommit: S.NullOr(CommitSchema),
});

/** Every issue event (`events: ["issues"]`). */
export type IssuesEvent =
  | IssueOpenedEvent
  | IssueLabeledEvent
  | IssueClosedEvent;

/** Every pull-request event (`events: ["pull_request"]`). */
export type PullRequestEvent =
  | PullRequestOpenedEvent
  | PullRequestMergedEvent
  | PullRequestClosedEvent;

/** Every repository event the typed wire delivers. */
export type RepositoryEvent =
  | IssuesEvent
  | IssueCommentedEvent
  | PullRequestEvent
  | PushEvent;

/**
 * The natural identity key of a repository event — the ONE correlation
 * function shared by routing (`send(item, { key })` names the run,
 * seen key ⇒ `steer`), the ledger (dedupe), and exit delivery
 * (`settle(key, event)`): `owner/repository#number` for issue- and
 * PR-scoped events; `undefined` for keyless events (push).
 */
export const eventKey = (event: RepositoryEvent): string | undefined => {
  const repo = `${event.repository.owner.login}/${event.repository.name}`;
  switch (event._tag) {
    case "IssueOpened":
    case "IssueLabeled":
    case "IssueCommented":
    case "IssueClosed":
      return `${repo}#${event.issue.number}`;
    case "PullRequestOpened":
    case "PullRequestMerged":
    case "PullRequestClosed":
      return `${repo}#${event.pullRequest.number}`;
    case "Push":
      return undefined;
  }
};

// ─── scoped constructors ──────────────────────────────────────────

/**
 * An issue opening in the repository — usually the message that creates
 * a case run (delivered by the front door with `send`, never
 * auto-subscribed).
 *
 * @example Plain ref (the simple path)
 * ```typescript
 * const alchemy = { owner: "alchemy-run", repository: "alchemy-effect" };
 *
 * class ResolveGitHubIssue extends AI.Process<ResolveGitHubIssue>()("ResolveGitHubIssue")`
 * ${AI.when(GitHub.IssueOpened(alchemy))} a new issue opens the case…` {}
 * ```
 *
 * @example Resource-first (the same program provisions the repository)
 * ```typescript
 * const repo = yield* GitHub.Repository("alchemy-effect", {
 *   owner: "alchemy-run",
 *   name: "alchemy-effect",
 * });
 *
 * // the source's name derives from the resource's FQN (stable logical
 * // identity); owner/name come from its identity props
 * const opened = GitHub.IssueOpened(repo);
 * ```
 *
 * @example Deferred (the exported, un-yielded constructor — module scope)
 * ```typescript
 * // repos.ts — the resource IS the export
 * export const alchemy = GitHub.Repository("alchemy-effect", {
 *   owner: "alchemy-run",
 *   name: "alchemy-effect",
 * });
 *
 * // processes.ts — a charter at module scope, before any Stack exists;
 * // the consuming Layer resolves the repo in-Effect (memoized by FQN)
 * ${AI.when(GitHub.IssueOpened(alchemy))} a new issue opens the case…
 * ```
 */
export const IssueOpened = (repo: RepositoryLike) => {
  const scope = normalizeRepo(repo);
  return Event(`github.issues.opened/${scopeKey(repo)}`, IssueOpenedEvent, {
    owner: "world",
    description: `an issue opens in ${describeRepo(scope)}`,
    key: identityKey,
  });
};

/**
 * An issue gaining the given label.
 *
 * @example
 * ```typescript
 * ${AI.when(GitHub.IssueLabeled(alchemy, "ready"))} dispatch a Fix run…
 * ```
 */
export const IssueLabeled = (repo: RepositoryLike, label: string) => {
  const scope = normalizeRepo(repo);
  return Event(
    `github.issues.labeled/${scopeKey(repo)}#${label}`,
    IssueLabeledEvent,
    {
      owner: "world",
      description: `an issue in ${describeRepo(scope)} is labeled ${label}`,
      key: identityKey,
    },
  );
};

/**
 * A comment landing on any issue in the repository. The front door
 * steers it to the issue's running case (`steer(runKey, msg)`) — a
 * comment is the conversation moving, never a new case.
 *
 * @example
 * ```typescript
 * ${AI.when(GitHub.IssueCommented(alchemy))} the conversation moved —
 * fold the comment into the running case…
 * ```
 */
export const IssueCommented = (repo: RepositoryLike) => {
  const scope = normalizeRepo(repo);
  return Event(
    `github.issues.commented/${scopeKey(repo)}`,
    IssueCommentedEvent,
    {
      owner: "world",
      description: `a comment lands on an issue in ${describeRepo(scope)}`,
      key: identityKey,
    },
  );
};

/**
 * GitHub closing an issue — the machine-observed exit of a case run
 * (`AI.exit(AI.when(GitHub.IssueClosed(repo)))`): the WORLD settles
 * the case, never the model's claim that it is done. Exit delivery is
 * delivery — the implementation Layer that consumed the wire hands the
 * close to the run (`settle(key, event)`), correlating by the source's
 * own `key` (`owner/repository#number`) — no per-charter match
 * callback needed.
 *
 * @example
 * ```typescript
 * ${AI.exit(AI.when(GitHub.IssueClosed(alchemy)))`whether the merged
 * pull request closed it or a maintainer closed it by hand`}
 * ```
 */
export const IssueClosed = (repo: RepositoryLike) => {
  const scope = normalizeRepo(repo);
  return Event(`github.issues.closed/${scopeKey(repo)}`, IssueClosedEvent, {
    owner: "world",
    description: `GitHub closes an issue in ${describeRepo(scope)}`,
    key: identityKey,
  });
};

/**
 * A pull request opening in the repository.
 */
export const PullRequestOpened = (repo: RepositoryLike) => {
  const scope = normalizeRepo(repo);
  return Event(
    `github.pull_request.opened/${scopeKey(repo)}`,
    PullRequestOpenedEvent,
    {
      owner: "world",
      description: `a pull request opens in ${describeRepo(scope)}`,
      key: identityKey,
    },
  );
};

/**
 * A pull request merging. GitHub signals merges as `pull_request` events
 * with `action: "closed"` and `merged: true` — the filter carries that
 * distinction for the channel Layer; a close-without-merge does not
 * match.
 */
export const PullRequestMerged = (repo: RepositoryLike) => {
  const scope = normalizeRepo(repo);
  return Event(
    `github.pull_request.merged/${scopeKey(repo)}`,
    PullRequestMergedEvent,
    {
      owner: "world",
      description: `a pull request merges in ${describeRepo(scope)}`,
      key: identityKey,
    },
  );
};

/**
 * A push to the given branch, optionally filtered by the head commit's
 * title prefix (e.g. release commits: `chore(release):`).
 *
 * @example
 * ```typescript
 * ${AI.when(GitHub.Push(alchemy, { branch: "main", titlePrefix: "chore(release):" }))}
 * a release landed — hand off to the blogger…
 * ```
 */
export const Push = (
  repo: RepositoryLike,
  filter: { branch: string; titlePrefix?: string },
) => {
  const scope = normalizeRepo(repo);
  return Event(`github.push/${scopeKey(repo)}@${filter.branch}`, PushEvent, {
    owner: "world",
    description: `a push lands on ${filter.branch} in ${describeRepo(scope)}`,
  });
};

// ─── the wire parser: one Octokit delivery → one typed event ────────

/**
 * Some payloads type `repository.owner` as nullable; the consumer's
 * RESOLVED repo ref is the authority when the wire omits it.
 */
const repositoryInfo = (
  repository: { name: string; owner?: { login?: string } | null },
  ref: { owner: string; repository: string },
): { name: string; owner: { login: string } } => ({
  name: repository.name,
  owner: { login: repository.owner?.login ?? ref.owner },
});

/**
 * Parse one webhook delivery into its typed {@link RepositoryEvent} —
 * TOTAL translation, no filtering: routing decisions belong to the
 * consumer (`Match.tag` in the process implementation), never to the
 * parser. `None` means the delivery's event/action has no tag in the
 * union yet (an `issues.edited`, a bot's noise) — extend the union
 * when a consumer needs it.
 *
 * The entity objects on the returned event (`issue`, `comment`,
 * `pullRequest`) are the wire's OWN objects, passed through by
 * reference — every delivered field survives at runtime; the schemas
 * type the principal fields.
 *
 * This is `consumeRepositoryEvents`' internal seam — handlers already
 * receive typed events and never see this function.
 */
export const parseWebhookEvent = (
  ref: { owner: string; repository: string },
  event: WebhookEvent,
): Option.Option<RepositoryEvent> => {
  switch (event.name) {
    case "issues": {
      const payload = event.payload;
      const repository = repositoryInfo(payload.repository, ref);
      const issue = payload.issue as IssueOpenedEvent["issue"];
      switch (payload.action) {
        case "opened":
          return Option.some({
            _tag: "IssueOpened",
            repository,
            issue,
          } satisfies IssueOpenedEvent);
        case "labeled":
          return payload.label?.name === undefined
            ? Option.none()
            : Option.some({
                _tag: "IssueLabeled",
                repository,
                issue,
                label: { name: payload.label.name },
              } satisfies IssueLabeledEvent);
        case "closed":
          return Option.some({
            _tag: "IssueClosed",
            repository,
            issue,
          } satisfies IssueClosedEvent);
        default:
          return Option.none();
      }
    }
    case "issue_comment": {
      const payload = event.payload;
      if (payload.action !== "created") return Option.none();
      return Option.some({
        _tag: "IssueCommented",
        repository: repositoryInfo(payload.repository, ref),
        issue: payload.issue as IssueCommentedEvent["issue"],
        comment: payload.comment as IssueCommentedEvent["comment"],
      } satisfies IssueCommentedEvent);
    }
    case "pull_request": {
      const payload = event.payload;
      const repository = repositoryInfo(payload.repository, ref);
      const pullRequest =
        payload.pull_request as PullRequestOpenedEvent["pullRequest"];
      switch (payload.action) {
        case "opened":
          return Option.some({
            _tag: "PullRequestOpened",
            repository,
            pullRequest,
          } satisfies PullRequestOpenedEvent);
        case "closed":
          // GitHub signals merges as closed+merged — two DISTINCT tags,
          // so consumers never re-derive the difference
          return Option.some(
            payload.pull_request.merged
              ? ({
                  _tag: "PullRequestMerged",
                  repository,
                  pullRequest,
                } satisfies PullRequestMergedEvent)
              : ({
                  _tag: "PullRequestClosed",
                  repository,
                  pullRequest,
                } satisfies PullRequestClosedEvent),
          );
        default:
          return Option.none();
      }
    }
    case "push": {
      const payload = event.payload;
      return Option.some({
        _tag: "Push",
        repository: repositoryInfo(payload.repository, ref),
        ref: payload.ref,
        branch: payload.ref.replace("refs/heads/", ""),
        headCommit: payload.head_commit ?? null,
      } satisfies PushEvent);
    }
    default:
      return Option.none();
  }
};
