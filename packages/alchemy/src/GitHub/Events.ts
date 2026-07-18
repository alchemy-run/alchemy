/**
 * The typed GitHub wire — the tagged event union
 * {@link consumeRepositoryEvents} delivers, the parser that produces
 * it ({@link parseWebhookEvent}), and the ONE identity function
 * ({@link eventKey}) delivery code correlates runs with.
 */
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import type { WebhookEvent } from "./RepositoryEventSource.ts";

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
