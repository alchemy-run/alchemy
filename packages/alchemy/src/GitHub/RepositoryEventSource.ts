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
  type IssueCommentedEvent,
  type IssuesEvent,
  parseWebhookEvent,
  type PullRequestEvent,
  type PushEvent,
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

/**
 * The typed events a handler receives for each requested bare webhook
 * name — parsing is the wire's job (`Match.tag` is the consumer's):
 * `issues` ⇒ {@link IssuesEvent}, `issue_comment` ⇒
 * {@link IssueCommentedEvent}, `pull_request` ⇒
 * {@link PullRequestEvent}, `push` ⇒ {@link PushEvent}. Bare names with
 * no tags in the union yet deliver nothing (extend
 * `GitHub.RepositoryEvent` when a consumer needs them).
 */
export type RepositoryEventFor<Name extends GitHubEventName> =
  Name extends "issues"
    ? IssuesEvent
    : Name extends "issue_comment"
      ? IssueCommentedEvent
      : Name extends "pull_request"
        ? PullRequestEvent
        : Name extends "push"
          ? PushEvent
          : never;

/**
 * Subscribe to events emitted by a GitHub repository — the repository
 * is the {@link Repository} RESOURCE (yielded or the un-yielded exported
 * const), and deliveries arrive ALREADY PARSED: the handler receives the
 * typed {@link RepositoryEvent} union (narrowed to the requested
 * `events`), never raw webhook payloads. Routing is `Match.tag`:
 *
 * Call it in the init phase of a host (e.g. a Cloudflare Worker); the
 * handler runs once per delivery. Wiring the webhook (delivery URL,
 * secret, IAM/bindings) is the providing Layer's job —
 * `Cloudflare.Workers.GitHubRepositoryEventSourceLive` provisions a
 * verified webhook; `GitHub.RepositoryEventSourcePolling` polls the same
 * events locally.
 * @binding
 * @example
 * ```typescript
 * yield* GitHub.consumeRepositoryEvents(
 *   repo, // GitHub.Repository — yielded, or the exported un-yielded const
 *   { events: ["issues", "issue_comment"] },
 *   (event) =>
 *     Match.value(event).pipe(
 *       Match.tag("IssueOpened", (event) => issues.send(event)),
 *       Match.tag("IssueCommented", (event) => issues.steer(GitHub.eventKey(event)!, event)),
 *       Match.orElse(() => Effect.void), // denial-by-skip, in code
 *     ),
 * );
 * ```
 */
export function consumeRepositoryEvents<
  const E extends readonly WebhookEventName[] = readonly WebhookEventName[],
  Req = never,
>(
  repo: RepositoryLike,
  options: RepositoryEventSourceOptions<E>,
  process: (
    event: RepositoryEventFor<SelectedEvent<E>>,
  ) => Effect.Effect<void, never, Req | Providers>,
): Effect.Effect<void, never, RepositoryEventSource> {
  return Effect.gen(function* () {
    const identity = yield* resolveRepository(repo);
    const source = yield* RepositoryEventSource;
    yield* source({ ...identity, ...options }, (delivery) =>
      Option.match(parseWebhookEvent(identity, delivery), {
        onNone: () => Effect.void,
        onSome: (event) =>
          process(event as RepositoryEventFor<SelectedEvent<E>>),
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
