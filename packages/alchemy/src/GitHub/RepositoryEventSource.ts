import type {
  EmitterWebhookEvent,
  EmitterWebhookEventName,
} from "@octokit/webhooks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import { sanitizeKey } from "../RuntimeContext.ts";
import {
  IssueClosed,
  IssueCommented,
  IssueLabeled,
  IssueOpened,
  parseWebhookEvent,
  PullRequestClosed,
  PullRequestMerged,
  PullRequestOpened,
  PullRequestSynchronized,
  Push,
} from "./Events.ts";
import type { Providers } from "./Providers.ts";
import { type RepositoryLike, resolveRepository } from "./RepositoryLike.ts";

/**
 * The bare GitHub webhook event names (e.g. `push`, `pull_request`), sourced
 * from `@octokit/webhooks`. Excludes the `event.action` emitter variants
 * (e.g. `pull_request.opened`) — webhooks are configured by bare event name.
 */
export type GitHubEventName = Exclude<
  EmitterWebhookEventName,
  `${string}.${string}`
>;

/**
 * Names selectable in {@link RepositoryEventSourceProps.events}: every bare
 * GitHub event name plus `"*"` to subscribe to all of them.
 *
 * @see {@link https://docs.github.com/en/webhooks/webhook-events-and-payloads | GitHub webhook events and payloads}
 */
export type WebhookEventName = GitHubEventName | "*";

/**
 * A single GitHub webhook delivery — Octokit's `EmitterWebhookEvent`, a
 * complete discriminated union of `{ id, name, payload }` keyed on `name`
 * with a fully-typed `payload` per event. `Name` narrows the union to the
 * events the subscriber selected, so `switch (event.name)` exhaustively
 * narrows `event.payload`.
 */
export type WebhookEvent<Name extends GitHubEventName = GitHubEventName> =
  EmitterWebhookEvent<Name>;

/**
 * The set of event names a handler can observe given the `events` it
 * selected. Selecting `"*"` (or omitting `events`) widens back to every
 * {@link GitHubEventName}; otherwise it's the union of the chosen literals.
 */
export type SelectedEvent<E extends readonly WebhookEventName[]> =
  "*" extends E[number] ? GitHubEventName : Exclude<E[number], "*">;

/**
 * The wire-level registration props the {@link RepositoryEventSource}
 * SERVICE takes — resolved plain identity plus subscription options.
 * Consumers never build this: {@link consumeRepositoryEvents} resolves
 * the {@link RepositoryLike} and passes it down.
 */
export interface RepositoryEventSourceProps<
  E extends readonly WebhookEventName[] = readonly WebhookEventName[],
> extends RepositoryEventSourceOptions<E> {
  /** Repository owner (user or organization). */
  owner: string;

  /** Repository name. */
  repository: string;
}

export interface RepositoryEventSourceOptions<
  E extends readonly WebhookEventName[] = readonly WebhookEventName[],
> {
  /**
   * GitHub event names to subscribe to (e.g. `["push", "pull_request"]`).
   * Use `["*"]` to receive every event GitHub emits.
   * @default ["push"]
   */
  events?: E;

  /**
   * Deliver `pull_request.opened` for every pull request that is
   * currently OPEN when a polling implementation registers — a PR
   * opened while no process was watching would otherwise never
   * deliver (polling cursors start at "now"). Delivery ids are
   * deterministic, so a ledgered consumer drops what it has already
   * seen. Ignored by push (webhook) implementations.
   * @default true
   */
  backfill?: boolean;

  /**
   * Secret used to verify each delivery's `HMAC-SHA256` signature. When set,
   * the event source provisions the webhook with this secret and the runtime
   * rejects deliveries whose `X-Hub-Signature-256` header doesn't match.
   * Strongly recommended — without it, anyone who learns the delivery URL can
   * forge events.
   */
  secret?: Redacted.Redacted<string>;

  /**
   * Path on the host that GitHub delivers to. Defaults to a deterministic
   * per-repository path so deliveries don't collide with your application
   * routes. Override only if you need a fixed, well-known path.
   */
  path?: string;
}

/** The event terms a subscription can select. */
export type RepositoryEventClass =
  | typeof IssueOpened
  | typeof IssueLabeled
  | typeof IssueCommented
  | typeof IssueClosed
  | typeof PullRequestOpened
  | typeof PullRequestSynchronized
  | typeof PullRequestMerged
  | typeof PullRequestClosed
  | typeof Push;

/** Which bare webhook each event term rides — the wire subscription. */
const WIRE_NAME = {
  IssueOpened: "issues",
  IssueLabeled: "issues",
  IssueClosed: "issues",
  IssueCommented: "issue_comment",
  PullRequestOpened: "pull_request",
  PullRequestSynchronized: "pull_request",
  PullRequestMerged: "pull_request",
  PullRequestClosed: "pull_request",
  Push: "push",
} as const satisfies Record<string, GitHubEventName>;

/** The consumer-facing subscription options: typed event terms. */
export interface ConsumeRepositoryEventsOptions<
  E extends readonly RepositoryEventClass[] = readonly RepositoryEventClass[],
> extends Omit<RepositoryEventSourceOptions, "events"> {
  /**
   * The typed EVENT TERMS to deliver (`[GitHub.IssueOpened]`) — the
   * handler's parameter type is exactly the union of their payloads.
   * The wire subscription (which bare webhooks to provision or poll)
   * is derived from the selection.
   */
  readonly events: E;
}

/**
 * Subscribe to events emitted by a GitHub repository — the repository
 * is the {@link Repository} RESOURCE (yielded or the un-yielded exported
 * const), and deliveries arrive ALREADY PARSED and PRE-SELECTED:
 * `events` names the typed event terms to deliver, and the handler
 * receives exactly that union, never raw webhook payloads.
 *
 * Call it in the init phase of a host (e.g. a Cloudflare Worker); the
 * handler runs once per delivery. Wiring the webhook (delivery URL,
 * secret, IAM/bindings) is the providing Layer's job —
 * `Cloudflare.Workers.GitHubRepositoryEventSourceLive` provisions a
 * verified webhook; `GitHub.RepositoryEventSourcePolling` polls the same
 * events locally.
 * **Example:** Example
 * ```typescript
 * yield* GitHub.consumeRepositoryEvents(
 *   repo, // GitHub.Repository — yielded, or the exported un-yielded const
 *   { events: [GitHub.IssueOpened, GitHub.IssueCommented] },
 *   (event) =>
 *     Match.value(event).pipe(
 *       Match.tag("IssueOpened", (event) => issues.send(event)),
 *       Match.tag("IssueCommented", (event) => issues.steer(GitHub.eventKey(event)!, event)),
 *       Match.exhaustive, // the selection IS the routing table
 *     ),
 * );
 * ```
 *
 * @binding
 * @binding
 */
export function consumeRepositoryEvents<
  const E extends readonly RepositoryEventClass[] =
    readonly RepositoryEventClass[],
  Req = never,
>(
  repo: RepositoryLike,
  options: ConsumeRepositoryEventsOptions<E>,
  process: (
    event: InstanceType<E[number]>,
  ) => Effect.Effect<void, never, Req | Providers>,
): Effect.Effect<void, never, RepositoryEventSource> {
  return Effect.gen(function* () {
    const identity = yield* resolveRepository(repo);
    const source = yield* RepositoryEventSource;
    const { events, ...rest } = options;
    const selected = new Set<string>(
      events.map((term) => term["~alchemy/Name"]),
    );
    const names = [
      ...new Set(
        events.map(
          (term) => WIRE_NAME[term["~alchemy/Name"] as keyof typeof WIRE_NAME],
        ),
      ),
    ];
    yield* source({ ...identity, ...rest, events: names }, (delivery) =>
      Option.match(parseWebhookEvent(identity, delivery), {
        onNone: () => Effect.void,
        onSome: (event) =>
          // finer than the wire: [IssueOpened] rides the `issues`
          // webhook but never delivers an IssueClosed
          selected.has(event._tag)
            ? process(event as InstanceType<E[number]>)
            : Effect.void,
      }),
    );
  });
}

export type RepositoryEventSourceService = <
  E extends readonly WebhookEventName[] = readonly WebhookEventName[],
  Req = never,
>(
  props: RepositoryEventSourceProps<E>,
  process: (
    event: WebhookEvent<SelectedEvent<E>>,
  ) => Effect.Effect<void, never, Req>,
) => Effect.Effect<void, never, never>;

export class RepositoryEventSource extends Context.Service<
  RepositoryEventSource,
  RepositoryEventSourceService
>()("GitHub.RepositoryEventSource") {}

/**
 * Deterministic delivery path for a repository's webhook. Shared by the
 * deploy-time policy (which registers the webhook URL) and the runtime
 * (which only claims requests on this path), so both sides agree.
 */
export const webhookPath = (props: {
  owner: string;
  repository: string;
  path?: string;
}): string =>
  props.path ?? `/__alchemy/github/${props.owner}/${props.repository}`;

/**
 * Deterministic env var name under which the deploy-time policy stores the
 * webhook secret on the host, so the runtime can read it back to verify
 * signatures.
 */
export const webhookSecretEnvName = (repository: {
  owner: string;
  repository: string;
}): string =>
  `ALCHEMY_GITHUB_WEBHOOK_SECRET_${sanitizeKey(repository.owner)}_${sanitizeKey(
    repository.repository,
  )}`;
