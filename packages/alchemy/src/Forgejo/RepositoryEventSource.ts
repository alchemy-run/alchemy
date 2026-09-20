import * as Effect from "effect/Effect";
import type { ForgejoSecret } from "./RuntimeTypes.ts";
import * as Schema from "effect/Schema";
import * as Binding from "../Binding.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { Repository } from "./Repository.ts";

/** Forgejo webhook user identity. */
export const RepositoryEventUser = Schema.Struct({
  id: Schema.Number,
  login: Schema.String,
});
/** Repository identity included in Forgejo deliveries. */
export const RepositoryEventRepository = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  full_name: Schema.String,
  private: Schema.Boolean,
  owner: RepositoryEventUser,
});
/** Validated Forgejo push payload (not a GitHub payload alias). */
export const PushPayload = Schema.Struct({
  ref: Schema.String,
  before: Schema.String,
  after: Schema.String,
  compare_url: Schema.String,
  commits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      message: Schema.String,
      url: Schema.String,
      timestamp: Schema.String,
      added: Schema.Array(Schema.String),
      removed: Schema.Array(Schema.String),
      modified: Schema.Array(Schema.String),
    }),
  ),
  repository: RepositoryEventRepository,
  pusher: RepositoryEventUser,
  sender: RepositoryEventUser,
});
/** Validated Forgejo issue payload. */
export const IssuesPayload = Schema.Struct({
  action: Schema.String,
  issue: Schema.Struct({
    id: Schema.Number,
    number: Schema.Number,
    title: Schema.String,
    body: Schema.String,
    state: Schema.String,
    user: RepositoryEventUser,
  }),
  repository: RepositoryEventRepository,
  sender: RepositoryEventUser,
});
export type RepositoryEventName = "push" | "issues";
export type RepositoryEvent<
  Name extends RepositoryEventName = RepositoryEventName,
> = Extract<
  | {
      readonly id: string;
      readonly name: "push";
      readonly payload: typeof PushPayload.Type;
    }
  | {
      readonly id: string;
      readonly name: "issues";
      readonly payload: typeof IssuesPayload.Type;
    },
  { readonly name: Name }
>;
export interface RepositoryEventSourceProps<
  Events extends readonly RepositoryEventName[] =
    readonly RepositoryEventName[],
> {
  /** Nonempty selection of supported, schema-validated event types. */
  readonly events: Events;
  /** Optional external signing secret. Omit for a persisted 32-byte random secret. */
  readonly secret?: ForgejoSecret;
}
export type RepositoryEventSourceService = (
  repository: Repository,
  props: RepositoryEventSourceProps,
  handler: (
    event: RepositoryEvent,
  ) => Effect.Effect<void, never, RuntimeContext>,
) => Effect.Effect<void>;

export interface RepositoryEventSource extends Binding.Service<
  RepositoryEventSource,
  "Forgejo.RepositoryEventSource",
  RepositoryEventSourceService
> {
  <const Events extends readonly RepositoryEventName[], Req = never>(
    repository: Repository | Effect.Effect<Repository, never, Req>,
    props: RepositoryEventSourceProps<Events>,
    handler: (
      event: RepositoryEvent<Events[number]>,
    ) => Effect.Effect<void, never, RuntimeContext>,
  ): Effect.Effect<void, never, RepositoryEventSource | Req>;
}

/**
 * Subscribe to signed Forgejo push and issue events. Provisions a persisted
 * random secret and a repository Webhook automatically; no runtime credential
 * or webhook-secret environment variable is required.
 *
 * Signature verification is mandatory. Secret changes replace the webhook
 * delete-first: deliveries can be interrupted until both hook and receiver
 * converge. This is not an atomic rotation.
 *
 * Subscriptions with the same repository and event selection share one receiver
 * and must reuse the same signing secret source. The receiver authenticates and
 * decodes once, then runs every subscriber. It acknowledges only after all
 * subscribers succeed; failures or a 30-second processing timeout return 503.
 * Redelivery can repeat successful subscribers, so side effects must be idempotent.
 *
 * ### Receiving Repository Events
 * **Example:** Subscribe inside a Worker or Lambda initialization effect
 * ```typescript
 * yield* Forgejo.RepositoryEventSource(repository, { events: ["push", "issues"] },
 *   event => Effect.log(`Received ${event.name} ${event.id}`));
 * ```
 *
 * @binding
 */
export const RepositoryEventSource = Binding.Service<RepositoryEventSource>(
  "Forgejo.RepositoryEventSource",
);
