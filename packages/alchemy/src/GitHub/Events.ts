/**
 * The GitHub event catalog — **world-owned** {@link EventSource}s scoped
 * to a repository (canon §2a rulings 4 + 6).
 *
 * Provider catalogs are repository-*generic*; charters consume *this*
 * repository's events. The constructors here are scoped: each takes a
 * repository and returns an `EventSource` **instance** carrying the
 * repository's provisioning props — it is what `AI.when` accepts (the
 * signature's inbound corner), what `AI.exit(AI.when(source))` observes
 * (the machine-observed exit), and what the channel Layer
 * ({@link GitHubEventsLive}) provisions from.
 *
 * Every source is marked `owner: "world"`: GitHub publishes these, a
 * process never can, so a bare `${GitHub.IssueOpened(repo)}` mention is
 * inert vocabulary (renders the name, grants nothing) — only the marked
 * signature expressions (`AI.when` / `AI.until`) put them to work, and
 * `ctx.emit` of one is a defect.
 *
 * These constructors are the AI-term analogue of
 * {@link consumeRepositoryEvents} (the world-side webhook consumer): at
 * deploy time an EventSource compiles to webhook-ingestion
 * infrastructure; the front door routes from that webhook to the
 * accepting process with explicit `send`/`steer`. The payload schemas
 * here are the **distilled work-item shapes** the org's processes
 * consume — deliberately NOT the full Octokit webhook payloads.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { type EventChannelService, EventSource } from "../AI/EventSource.ts";
import { isResourceOfType } from "../Resource.ts";
import type { Repository } from "./Repository.ts";
import type {
  GitHubEventName,
  RepositoryRef,
  WebhookEvent,
} from "./RepositoryEventSource.ts";

/**
 * The channel tag for the GitHub event family: the service a harness
 * must provide to deliver these sources. The tag joins a term's `Req`
 * where the term holds a process-side obligation — for world-owned
 * sources that is exactly the machine-observed halt
 * (`AI.exit(AI.when(GitHub.IssueClosed(repo)))`): the kernel must observe
 * the world on the process's behalf. `AI.when` contributes nothing (the
 * front door that subscribes and delivers holds the consuming
 * obligation), and a bare mention contributes nothing (world-owned
 * sources have no publish affordance).
 *
 * Holding the tag is what obligates the deployment to provision the
 * delivery wire — on Cloudflare: a repository webhook pointing at the
 * Worker, provisioned by {@link GitHubEventsLive} through
 * `GitHub.RepositoryEventSource`, driven by the union of subscribed
 * sources' props, never a side list.
 */
export class GitHubEvents extends Context.Service<
  GitHubEvents,
  EventChannelService
>()("GitHub.Events") {}

/**
 * Pure definition data carried by every GitHub source (the binding
 * idiom: props tell the channel Layer what to provision and what to
 * filter; behavior lives exclusively in the Layer).
 */
export interface GitHubSourceProps {
  /**
   * The repository whose events this source delivers. The resolved
   * forms (plain ref, yielded resource) are normalized to a plain
   * `{ owner, repository }` at construction; the deferred form (an
   * un-yielded `GitHub.Repository(...)` constructor Effect) is carried
   * as-is and resolved in-Effect by the consuming Layer via
   * {@link resolveRepositoryRef}.
   */
  repo: RepositoryRef | Effect.Effect<Repository, any, any>;
  /** Bare GitHub event name — what the webhook is provisioned with. */
  event: GitHubEventName;
  /** Family-specific runtime filter (action, label, branch, …). */
  filter?: Record<string, string | undefined>;
}

/**
 * What a scoped constructor accepts — the same three forms a binding
 * accepts its host resource in:
 *
 * - a plain `{ owner, repository }` ref (the simple path — also what
 *   {@link consumeRepositoryEvents} takes);
 * - a provisioned (yielded) {@link Repository} resource — resource-first
 *   inside a Stack program;
 * - the **un-yielded constructor Effect** itself
 *   (`export const repo = GitHub.Repository("repo", {...})`) — the
 *   deferred form, usable at module scope before any Stack exists.
 *   Resources are memoized by FQN, so the Layer that later yields the
 *   same exported const resolves the one instance the Stack provisioned.
 */
export type RepositoryLike =
  | RepositoryRef
  | Repository
  | Effect.Effect<Repository, any, any>;

const isRepositoryResource = (repo: RepositoryLike): repo is Repository =>
  isResourceOfType(repo, "GitHub.Repository");

/**
 * Stable per-module-load identity for the DEFERRED form: the un-yielded
 * constructor Effect exposes nothing statically (FQN/Props only exist on
 * the instance yielded inside a Stack), so the source's display name gets
 * a placeholder keyed on the Effect **object** — the same exported const
 * always maps to the same `N`.
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
 * - plain ref → `owner/repository`;
 * - resource → its `FQN` (namespace path + logical ID) — the resource's
 *   *stable logical identity*, unchanged by a repository rename (a
 *   rename converges in place; the FQN names the declaration, not the
 *   current cloud name);
 * - deferred constructor Effect → `@deferred:N` (stable per module
 *   load; same exported Effect ⇒ same `N`).
 *
 * The name is DISPLAY/topology identity only — the **wire identity**
 * (which repo to provision and filter) always resolves from
 * `props.repo` in-Effect via {@link resolveRepositoryRef}. The
 * kernel-internal EventBus correlates on the name, but world-owned
 * GitHub sources ride the channel (the webhook wire), not the bus, so
 * the placeholder never becomes a wire key.
 */
const scopeKey = (repo: RepositoryLike): string =>
  isRepositoryResource(repo)
    ? repo.FQN
    : Effect.isEffect(repo)
      ? deferredKey(repo)
      : `${repo.owner}/${repo.repository}`;

/**
 * Synchronous fast-path: the plain `{ owner, repository }` for the two
 * RESOLVED forms (plain ref, yielded resource).
 *
 * For a {@link Repository} resource the identity is read from its
 * **input props** (`Props.owner` / `Props.name`) — they are the
 * repository's identity (owner change = replacement, name change =
 * in-place rename) and are plain strings in the canonical usage. Webhook
 * provisioning needs plan-time strings (the delivery path and the
 * webhook's logical ID derive from them), so unresolved inputs (an
 * `Output`/`Config`/`Effect` owner or name) are a construction-time
 * defect directing the caller to the plain-ref form.
 */
const scopeRef = (repo: RepositoryRef | Repository): RepositoryRef => {
  if (!isRepositoryResource(repo)) return repo;
  const { owner, name } = repo.Props;
  if (typeof owner !== "string" || typeof name !== "string") {
    throw new Error(
      `GitHub event sources need the repository's identity as plain strings at construction time, but ${repo.FQN} was declared with unresolved owner/name inputs — pass a plain { owner, repository } ref instead`,
    );
  }
  return { owner, repository: name };
};

/**
 * Normalize what a scoped constructor stores in `props.repo`: the
 * resolved forms collapse to a plain ref eagerly (today's behavior —
 * unresolved inputs defect at construction with a clear message); the
 * deferred form is carried as-is for the Layer to resolve in-Effect.
 */
const normalizeRepo = (
  repo: RepositoryLike,
): RepositoryRef | Effect.Effect<Repository, any, any> =>
  Effect.isEffect(repo) ? repo : scopeRef(repo);

/**
 * The repository as it reads in a source's rendered clause (its
 * `description` — the combinator contract): resolved forms name the
 * repo (`owner/repository`); the DEFERRED form can't know the strings
 * at construction (like the `@deferred:N` display name above, the true
 * identity only exists in-Effect), so its clauses use the generic
 * "the repository" — still a full, readable clause.
 */
const describeRepo = (
  scope: RepositoryRef | Effect.Effect<Repository, any, any>,
): string =>
  Effect.isEffect(scope)
    ? "the repository"
    : `${scope.owner}/${scope.repository}`;

/**
 * The natural identity key of issue/PR-scoped GitHub events (the
 * EventSource `key` contract): `owner/repository#number` — the ONE
 * correlation function shared by the front door (steering key: first
 * key ⇒ `send` creates the run, seen key ⇒ `steer`) and the kernel
 * (machine-observed exits settle on key equality between the run's
 * work item and the observed event). Returns `undefined` when the
 * value doesn't carry the identity fields (e.g. a plain-string work
 * item) — consumers fall back to their keyless behavior.
 */
const identityKey = (value: {
  owner?: unknown;
  repository?: unknown;
  number?: unknown;
}): string | undefined =>
  typeof value?.owner === "string" &&
  typeof value?.repository === "string" &&
  typeof value?.number === "number"
    ? `${value.owner}/${value.repository}#${value.number}`
    : undefined;

/**
 * THE one resolver every consuming Layer uses to turn a source's
 * `props.repo` (any {@link RepositoryLike} form) into the plain
 * `{ owner, repository }` it provisions and filters with:
 *
 * - plain ref → succeeds as-is;
 * - yielded {@link Repository} → identity props (`Props.owner` /
 *   `Props.name`; defect if not plain strings);
 * - deferred constructor Effect → `yield*`s it. Resources are memoized
 *   by FQN, so this resolves the same instance the Stack yielded.
 *
 * R is typed `never` with one well-commented internal cast: the deferred
 * Effect's own requirements (Stack, namespace, provider) cannot be
 * carried on the term type (the Layer walks refs at RUNTIME of its init
 * Effect), and they are satisfied wherever bindings are legal — a host's
 * init Effect runs at plan time under the Stack (the bindings
 * precedent). Yielding a deferred source anywhere else is a defect at
 * runtime (a missing-service die), same as any out-of-phase binding.
 */
export const resolveRepositoryRef = (
  repo: RepositoryLike,
): Effect.Effect<RepositoryRef> =>
  Effect.isEffect(repo)
    ? Effect.map(
        // SAFETY: see JSDoc — the deferred form is only legal where
        // bindings are legal (host init phase, under the Stack); the
        // Effect's true R (Stack | CurrentNamespace | Provider) is
        // ambient there. Elsewhere this dies at runtime, by design.
        repo as Effect.Effect<Repository>,
        (resolved) => scopeRef(resolved),
      )
    : Effect.sync(() => scopeRef(repo));

// ─── payload schemas: distilled work-item shapes, not Octokit ─────

export const IssueOpenedEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
  title: S.String,
  body: S.String,
});

export const IssueLabeledEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
  label: S.String,
});

export const IssueCommentedEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
  author: S.String,
  comment: S.String,
});

export const IssueClosedEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
});

export const PullRequestOpenedEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
  title: S.String,
});

export const PullRequestMergedEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  number: S.Number,
});

export const PushEvent = S.Struct({
  owner: S.String,
  repository: S.String,
  branch: S.String,
  title: S.String,
});

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
  return EventSource(
    `github.issues.opened/${scopeKey(repo)}`,
    IssueOpenedEvent,
    GitHubEvents,
    {
      repo: scope,
      event: "issues",
      filter: { action: "opened" },
    } satisfies GitHubSourceProps,
    {
      owner: "world",
      description: `an issue opens in ${describeRepo(scope)}`,
      key: identityKey,
    },
  );
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
  return EventSource(
    `github.issues.labeled/${scopeKey(repo)}#${label}`,
    IssueLabeledEvent,
    GitHubEvents,
    {
      repo: scope,
      event: "issues",
      filter: { action: "labeled", label },
    } satisfies GitHubSourceProps,
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
  return EventSource(
    `github.issues.commented/${scopeKey(repo)}`,
    IssueCommentedEvent,
    GitHubEvents,
    {
      repo: scope,
      event: "issue_comment",
      filter: { action: "created" },
    } satisfies GitHubSourceProps,
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
 * the case, never the model's claim that it is done. The kernel holds
 * the one internal subscription for this (the halt's channel tag joins
 * `Req`), correlating runs by the source's own `key`
 * (`owner/repository#number`) — no per-charter match callback needed.
 *
 * @example
 * ```typescript
 * ${AI.exit(AI.when(GitHub.IssueClosed(alchemy)))`whether the merged
 * pull request closed it or a maintainer closed it by hand`}
 * ```
 */
export const IssueClosed = (repo: RepositoryLike) => {
  const scope = normalizeRepo(repo);
  return EventSource(
    `github.issues.closed/${scopeKey(repo)}`,
    IssueClosedEvent,
    GitHubEvents,
    {
      repo: scope,
      event: "issues",
      filter: { action: "closed" },
    } satisfies GitHubSourceProps,
    {
      owner: "world",
      description: `GitHub closes an issue in ${describeRepo(scope)}`,
      key: identityKey,
    },
  );
};

/**
 * A pull request opening in the repository.
 */
export const PullRequestOpened = (repo: RepositoryLike) => {
  const scope = normalizeRepo(repo);
  return EventSource(
    `github.pull_request.opened/${scopeKey(repo)}`,
    PullRequestOpenedEvent,
    GitHubEvents,
    {
      repo: scope,
      event: "pull_request",
      filter: { action: "opened" },
    } satisfies GitHubSourceProps,
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
  return EventSource(
    `github.pull_request.merged/${scopeKey(repo)}`,
    PullRequestMergedEvent,
    GitHubEvents,
    {
      repo: scope,
      event: "pull_request",
      filter: { action: "closed", merged: "true" },
    } satisfies GitHubSourceProps,
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
  return EventSource(
    `github.push/${scopeKey(repo)}@${filter.branch}`,
    PushEvent,
    GitHubEvents,
    {
      repo: scope,
      event: "push",
      filter: { ...filter },
    } satisfies GitHubSourceProps,
    {
      owner: "world",
      description: `a push lands on ${filter.branch} in ${describeRepo(scope)}`,
    },
  );
};

// ─── payload adapters: Octokit wire → the distilled catalog shapes ──

/**
 * Push payloads type `repository.owner` as nullable; the source's own
 * RESOLVED repo ref is the authority when the wire omits it.
 */
const ownerLogin = (
  owner: { login?: string } | null | undefined,
  ref: RepositoryRef,
): string => owner?.login ?? ref.owner;

/**
 * Adapt one webhook delivery to a source's distilled payload shape —
 * the anti-corruption seam of the DERIVED front door (canon §5,
 * designs/ai/business-processes.md): match the source's `props.event` +
 * `props.filter` (action, label, branch as `refs/heads/…`, title prefix
 * against the head commit's first line) against the delivery, then map
 * the Octokit payload to the catalog schema shape ({@link IssueOpenedEvent},
 * {@link PushEvent}, …). `None` means "this delivery is not this
 * source's message" — the caller skips it (denial-by-skip lives at the
 * consuming site, never inside a process).
 *
 * Takes the RESOLVED `{ owner, repository }` alongside the props: the
 * caller resolves `props.repo` once (any {@link RepositoryLike} form)
 * via {@link resolveRepositoryRef} before entering the delivery path,
 * so adaptation stays synchronous and pure.
 *
 * Internal-only: consumed by `GitHub.frontDoor`. It rides the barrel
 * with the rest of this module, but it is not part of the public
 * catalog surface — a hand-written front door adapts in its own
 * handler.
 */
export const adaptWebhookEvent = (
  ref: RepositoryRef,
  props: GitHubSourceProps,
  event: WebhookEvent,
): Option.Option<unknown> => {
  if (event.name !== props.event) return Option.none();
  const filter = props.filter ?? {};
  switch (event.name) {
    case "issues": {
      const payload = event.payload;
      if (filter.action !== undefined && payload.action !== filter.action) {
        return Option.none();
      }
      const base = {
        owner: ownerLogin(payload.repository.owner, ref),
        repository: payload.repository.name,
        number: payload.issue.number,
      };
      if (payload.action === "opened") {
        return Option.some({
          ...base,
          title: payload.issue.title,
          body: payload.issue.body ?? "",
        });
      }
      if (payload.action === "labeled") {
        const label = payload.label?.name;
        if (label === undefined) return Option.none();
        if (filter.label !== undefined && label !== filter.label) {
          return Option.none();
        }
        return Option.some({ ...base, label });
      }
      if (payload.action === "closed") return Option.some(base);
      return Option.none();
    }
    case "issue_comment": {
      const payload = event.payload;
      if (filter.action !== undefined && payload.action !== filter.action) {
        return Option.none();
      }
      return Option.some({
        owner: ownerLogin(payload.repository.owner, ref),
        repository: payload.repository.name,
        number: payload.issue.number,
        author: payload.comment.user?.login ?? "unknown",
        comment: payload.comment.body,
      });
    }
    case "pull_request": {
      const payload = event.payload;
      if (filter.action !== undefined && payload.action !== filter.action) {
        return Option.none();
      }
      // merges arrive as closed+merged (see PullRequestMerged): the
      // filter carries the distinction; a close-without-merge skips
      if (filter.merged === "true" && !payload.pull_request.merged) {
        return Option.none();
      }
      const base = {
        owner: ownerLogin(payload.repository.owner, ref),
        repository: payload.repository.name,
        number: payload.pull_request.number,
      };
      if (payload.action === "opened") {
        return Option.some({ ...base, title: payload.pull_request.title });
      }
      return Option.some(base);
    }
    case "push": {
      const payload = event.payload;
      const branch = payload.ref.replace("refs/heads/", "");
      if (filter.branch !== undefined && branch !== filter.branch) {
        return Option.none();
      }
      const title = payload.head_commit?.message.split("\n")[0] ?? "";
      if (
        filter.titlePrefix !== undefined &&
        !title.startsWith(filter.titlePrefix)
      ) {
        return Option.none();
      }
      return Option.some({
        owner: ownerLogin(payload.repository.owner, ref),
        repository: payload.repository.name,
        branch,
        title,
      });
    }
    default:
      return Option.none();
  }
};
