/**
 * The typed GitHub wire — the tagged event union
 * {@link consumeRepositoryEvents} delivers, the parser that produces
 * it ({@link parseWebhookEvent}), and the ONE identity function
 * ({@link eventKey}) delivery code correlates runs with.
 *
 * Each event is ONE `AI.Event` class: the class is the payload type,
 * the static carries the runtime schema, and the template is the
 * event's canonical prose — so a charter can splice
 * `${GitHub.IssueOpened}` directly, and a subscription selects typed
 * terms (`events: [GitHub.IssueOpened]`). Parsing is TOTAL
 * translation, no filtering — routing decisions belong to the
 * consumer, never to the parser.
 */
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { Event } from "../AI/Event.ts";
import type { WebhookEvent } from "./RepositoryEventSource.ts";

// Each wire struct is ONE name declared twice — a NAMED interface (so
// hovers read `Issue`, never a structural expansion) merged with the
// schema const of the same name (`S.Schema<Issue>` pins the const's
// Type to the interface, so the two can never drift).

export interface Actor {
  readonly login: string;
}

export const Actor: S.Schema<Actor> = S.Struct({
  login: S.String,
});

export interface RepositoryInfo {
  /** Repository name (`alchemy-effect`). */
  readonly name: string;
  readonly owner: Actor;
}

export const RepositoryInfo: S.Schema<RepositoryInfo> = S.Struct({
  name: S.String,
  owner: Actor,
});

export interface Label {
  readonly name: string;
}

export const Label: S.Schema<Label> = S.Struct({
  name: S.String,
});

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
  /**
   * GitHub's own PR marker: present exactly when this "issue" is a
   * pull request (`issue_comment` is one door for both thread kinds).
   */
  readonly pull_request?: unknown;
}

export const Issue: S.Schema<Issue> = S.Struct({
  number: S.Number,
  title: S.String,
  body: S.optionalKey(S.NullOr(S.String)),
  state: S.optionalKey(S.String),
  html_url: S.optionalKey(S.String),
  user: S.optionalKey(S.NullOr(Actor)),
  labels: S.optionalKey(S.Array(Label)),
  created_at: S.optionalKey(S.String),
  closed_at: S.optionalKey(S.NullOr(S.String)),
  pull_request: S.optionalKey(S.Unknown),
});

/** The principal fields of an issue comment as delivered by the wire. */
export interface IssueComment {
  readonly body: string;
  readonly user?: Actor | null;
  readonly html_url?: string;
  readonly created_at?: string;
}

export const IssueComment: S.Schema<IssueComment> = S.Struct({
  body: S.String,
  user: S.optionalKey(S.NullOr(Actor)),
  html_url: S.optionalKey(S.String),
  created_at: S.optionalKey(S.String),
});

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

export const PullRequest: S.Schema<PullRequest> = S.Struct({
  number: S.Number,
  title: S.String,
  body: S.optionalKey(S.NullOr(S.String)),
  state: S.optionalKey(S.String),
  html_url: S.optionalKey(S.String),
  user: S.optionalKey(S.NullOr(Actor)),
  merged: S.optionalKey(S.Boolean),
  merge_commit_sha: S.optionalKey(S.NullOr(S.String)),
  head: S.optionalKey(S.Struct({ ref: S.String })),
  base: S.optionalKey(S.Struct({ ref: S.String })),
});

export interface Commit {
  readonly id: string;
  readonly message: string;
}

export const Commit: S.Schema<Commit> = S.Struct({
  id: S.String,
  message: S.String,
});

// ─── the events ─────────────────────────────────────────────────────

export class IssueOpened extends (Event("IssueOpened", {
  repository: RepositoryInfo,
  issue: Issue,
})`
An issue was opened in the repository — number, title, body, labels,
and author, as the wire delivers them.`) {}

export class IssueLabeled extends (Event("IssueLabeled", {
  repository: RepositoryInfo,
  issue: Issue,
  label: Label,
})`
A label was added to an issue.`) {}

export class IssueCommented extends (Event("IssueCommented", {
  repository: RepositoryInfo,
  issue: Issue,
  comment: IssueComment,
})`
Someone commented on an issue or pull request — GitHub's one door
for both.`) {}

/**
 * Whether an {@link IssueCommented} landed on a PULL REQUEST thread
 * (GitHub delivers both through the one `issue_comment` door; the
 * `issue.pull_request` marker tells them apart). Routing should send
 * PR-thread comments to the pull-request owner, not the issues owner.
 */
export const isPullRequestComment = (event: IssueCommented): boolean =>
  event.issue.pull_request !== undefined;

export class IssueClosed extends (Event("IssueClosed", {
  repository: RepositoryInfo,
  issue: Issue,
})`
An issue was closed, by whom and however — the world's word, not
this org's.`) {}

export class PullRequestOpened extends (Event("PullRequestOpened", {
  repository: RepositoryInfo,
  pullRequest: PullRequest,
})`
A pull request was opened — number, title, body, branches, author.`) {}

export class PullRequestMerged extends (Event("PullRequestMerged", {
  repository: RepositoryInfo,
  pullRequest: PullRequest,
})`
A pull request was merged.`) {}

/** A pull request closed WITHOUT merging (merges are {@link PullRequestMerged}). */
export class PullRequestClosed extends (Event("PullRequestClosed", {
  repository: RepositoryInfo,
  pullRequest: PullRequest,
})`
A pull request was closed without merging.`) {}

export class Push extends (Event("Push", {
  repository: RepositoryInfo,
  /** The full git ref (`refs/heads/main`). */
  ref: S.String,
  /** The branch name (`main`), derived from `ref`. */
  branch: S.String,
  headCommit: S.NullOr(Commit),
})`
Commits were pushed to a branch of the repository.`) {}

/** Every issue event (the `issues` webhook). */
export type IssuesEvent = IssueOpened | IssueLabeled | IssueClosed;

/** Every pull-request event (the `pull_request` webhook). */
export type PullRequestEvent =
  | PullRequestOpened
  | PullRequestMerged
  | PullRequestClosed;

/** Every repository event the typed wire delivers. */
export type RepositoryEvent =
  | IssuesEvent
  | IssueCommented
  | PullRequestEvent
  | Push;

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
      const issue = payload.issue as IssueOpened["issue"];
      switch (payload.action) {
        case "opened":
          return Option.some({
            _tag: "IssueOpened",
            repository,
            issue,
          } satisfies IssueOpened);
        case "labeled":
          return payload.label?.name === undefined
            ? Option.none()
            : Option.some({
                _tag: "IssueLabeled",
                repository,
                issue,
                label: { name: payload.label.name },
              } satisfies IssueLabeled);
        case "closed":
          return Option.some({
            _tag: "IssueClosed",
            repository,
            issue,
          } satisfies IssueClosed);
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
        issue: payload.issue as IssueCommented["issue"],
        comment: payload.comment as IssueCommented["comment"],
      } satisfies IssueCommented);
    }
    case "pull_request": {
      const payload = event.payload;
      const repository = repositoryInfo(payload.repository, ref);
      const pullRequest =
        payload.pull_request as PullRequestOpened["pullRequest"];
      switch (payload.action) {
        case "opened":
          return Option.some({
            _tag: "PullRequestOpened",
            repository,
            pullRequest,
          } satisfies PullRequestOpened);
        case "closed":
          // GitHub signals merges as closed+merged — two DISTINCT tags,
          // so consumers never re-derive the difference
          return Option.some(
            payload.pull_request.merged
              ? ({
                  _tag: "PullRequestMerged",
                  repository,
                  pullRequest,
                } satisfies PullRequestMerged)
              : ({
                  _tag: "PullRequestClosed",
                  repository,
                  pullRequest,
                } satisfies PullRequestClosed),
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
      } satisfies Push);
    }
    default:
      return Option.none();
  }
};
