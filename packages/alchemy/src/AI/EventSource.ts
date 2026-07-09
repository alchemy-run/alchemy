import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as S from "effect/Schema";
import type * as Stream from "effect/Stream";

/**
 * The service contract of an event **channel** — one tag per event
 * family (`GitHubEvents`, `DiscordEvents`), declared by the provider
 * module:
 *
 * ```ts
 * export class GitHubEvents extends Context.Service<
 *   GitHubEvents,
 *   AI.EventChannelService
 * >()("org/GitHubEvents") {}
 * ```
 *
 * `subscribe` is the channel's analogue of a `Binding.Service`'s
 * `bind(resource)` — **one call, two halves**, guarded internally by
 * `__ALCHEMY_RUNTIME__` exactly like every other binding implementation:
 *
 * - **Plan time**: provision the delivery infrastructure for the source's
 *   `props` (on Cloudflare: a repository `Webhook` resource via
 *   `GitHub.RepositoryEventSource`, FQN-deduped per `(repo, event)`) and
 *   bind any secrets/env the runtime needs.
 * - **Runtime**: return the stream of verified, schema-decoded events for
 *   this source.
 *
 * The kernel calls `subscribe` while interpreting a loop's triggers — in
 * the host's init phase, where both halves are legal — resolving the tag
 * from ambient context the same way it resolves tool refs.
 */
export interface EventChannelService {
  subscribe<In>(
    source: EventSource<In, any, any>,
  ): Effect.Effect<Stream.Stream<In>>;
}

/**
 * A world-side topic that a {@link Loop} may subscribe to via `AI.on`.
 *
 * An `EventSource` is **pure definition data** — the binding idiom
 * (declaration = data; provisioning + delivery = the per-cloud Layer):
 *
 * - `~alchemy/Name` — deterministic identity
 *   (`github.issues.opened/owner/repo`).
 * - `schema` — the payload type (`In`).
 * - `channel` — the family tag whose Layer supplies the physics. The tag
 *   flows through the trigger into the loop's `Req`, so **declaring the
 *   subscription is what obligates the deployment**: a charter that
 *   interpolates `${AI.on(Github.IssueOpened(repo))}` does not type-check
 *   until the worker's Layer graph provides the channel — and the
 *   channel's own Layer requirements (e.g. `GitHub.RepositoryEventSource`
 *   on Cloudflare) are the second, transitive compile fence.
 * - `props` — pure, family-specific config (repo ref, bare event name,
 *   label/branch filters) that tells the channel Layer *what to
 *   provision* and *what to filter*. Props carry no behavior; there is no
 *   effect on a declaration anywhere in alchemy.
 *
 * A source constructed without a channel (`Channel = never`) is
 * kernel-internal: deliverable only by the harness's own event bus
 * (tests, `AI.Kernel.memory`).
 */
export interface EventSource<In = unknown, Channel = never, Props = unknown> {
  "~alchemy/Kind": "EventSource";
  "~alchemy/Name": string;
  /** Phantom carrier for the channel tag (`Context.Service` is invariant). */
  "~alchemy/Channel": Channel;
  schema: S.Top & { readonly Type: In };
  /** The channel tag's runtime handle; `undefined` = kernel-internal. */
  channel: Context.Service<any, EventChannelService> | undefined;
  /** Pure, family-specific config (repo ref, event name, filters, …). */
  props: Props;
}

export const EventSource: {
  <const Name extends string, Schema extends S.Top>(
    name: Name,
    schema: Schema,
  ): EventSource<Schema["Type"], never, undefined>;
  <const Name extends string, Schema extends S.Top, Channel>(
    name: Name,
    schema: Schema,
    channel: Context.Service<Channel, EventChannelService>,
  ): EventSource<Schema["Type"], Channel, undefined>;
  <const Name extends string, Schema extends S.Top, Channel, const Props>(
    name: Name,
    schema: Schema,
    channel: Context.Service<Channel, EventChannelService>,
    props: Props,
  ): EventSource<Schema["Type"], Channel, Props>;
} = (
  name: string,
  schema: S.Top,
  channel?: Context.Service<any, EventChannelService>,
  props?: unknown,
): any => ({
  "~alchemy/Kind": "EventSource",
  "~alchemy/Name": name,
  schema,
  channel,
  props,
});

export const isEventSource = (
  value: unknown,
): value is EventSource<unknown, any, any> =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "EventSource";
