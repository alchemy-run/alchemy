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
 * The kernel calls `subscribe` while interpreting a term's signature
 * (machine-observed halts) — in the host's init phase, where both halves
 * are legal — resolving the tag from ambient context the same way it
 * resolves tool refs.
 */
export interface EventChannelService {
  subscribe<In>(
    source: EventSource<In, any, any>,
  ): Effect.Effect<Stream.Stream<In>>;
}

/**
 * Who publishes a source (canon §2a ruling 4). Affordances are
 * owner-sensitive:
 *
 * - `"org"` (the default) — an org-internal broadcast: a process may
 *   publish it, so a bare `${X}` mention IS the publish grant (joins
 *   `emits` topology, permits `ctx.emit(X, payload)`, contributes the
 *   channel tag to `Req` when channel-backed).
 * - `"world"` — a provider-catalog source (`GitHub.IssueOpened(repo)`):
 *   the WORLD publishes it, a process never can, so a bare mention
 *   affords nothing — it renders as vocabulary (the event's name) and
 *   grants no publish topology, no channel obligation, no `ctx.emit`.
 *   Inbound use is always marked: `AI.when(X)` to accept,
 *   `AI.exit(AI.when(X))` for a machine-observed exit (the halt DOES
 *   place the channel tag in `Req` — the kernel must observe the world).
 */
export type EventSourceOwner = "world" | "org";

export interface EventSourceOptions<Owner extends EventSourceOwner> {
  owner: Owner;
  /**
   * The term's rendered clause (the combinator contract from the prose
   * guide, §2.2): a present-tense phrase completing "when ___" — e.g.
   * "an issue opens in alchemy-run/test-alchemy". The *term author*
   * writes the clause once; every charter author composes sentences
   * with it: `AI.when(X)` renders "when {description}", and a
   * machine-observed exit (`AI.exit(AI.when(X))`) renders it as the
   * exit clause ("This run ends when: {description}"). Without one,
   * the marked expressions fall back to the source's name — legible,
   * but write the description.
   */
  description?: string;
  /**
   * The source's **natural identity key** — a pure function from a
   * payload (or a payload-shaped work item) to the string naming the
   * world entity the event is about (e.g. `owner/repo#number`).
   * Declared ONCE by whoever defines the event family; every consumer
   * derives correlation from it: the front door uses it to address the
   * running actor (first key ⇒ `send` creates the run, seen key ⇒
   * `steer`), and the kernel uses it to correlate a machine-observed
   * exit to its run (default match: key equality between the run's
   * work item and the observed event). May return `undefined` when the
   * value doesn't carry the identity fields (e.g. a plain-string work
   * item) — consumers fall back to their keyless behavior.
   */
  key?: (payload: any) => string | undefined;
}

/**
 * A named broadcast channel — a world-side topic a {@link Process} may
 * name in its signature (`AI.when(X)` to accept, `AI.exit(AI.when(X))` for
 * a machine-observed exit) or mention bare (`${X}`) as a publish grant.
 *
 * An `EventSource` is **pure definition data** — the binding idiom
 * (declaration = data; provisioning + delivery = the per-cloud Layer):
 *
 * - `~alchemy/Name` (aliased as `name`) — deterministic identity
 *   (`github.issues.opened/owner/repo`).
 * - `schema` — the payload type (`In`).
 * - `channel` — the family tag whose Layer supplies the physics. The tag
 *   joins a term's `Req` wherever the term holds a *process-side*
 *   obligation on the channel — a bare `${X}` mention (publishing needs
 *   the channel's physics) or a machine-observed halt (the kernel must
 *   observe the world) — so **holding the obligation is what obligates
 *   the deployment**: the term does not type-check until the worker's
 *   Layer graph provides the channel, and the channel's own Layer
 *   requirements (e.g. `GitHub.RepositoryEventSource` on Cloudflare) are
 *   the second, transitive compile fence. `AI.when` contributes nothing:
 *   delivery is outside code, so that fence rides the consuming call site.
 * - `props` — pure, family-specific config (repo ref, bare event name,
 *   label/branch filters) that tells the channel Layer *what to
 *   provision* and *what to filter*. Props carry no behavior; there is no
 *   effect on a declaration anywhere in alchemy.
 * - `~alchemy/Owner` — who publishes it (see {@link EventSourceOwner}).
 *   World-owned sources (provider catalogs) afford nothing by bare
 *   mention; the constructors that build them narrow the field to the
 *   `"world"` literal so the gate holds at the type level too.
 *
 * A source constructed without a channel (`Channel = never`) is
 * kernel-internal: deliverable only by the harness's own event bus
 * (tests, `AI.Kernel.memory`).
 */
export interface EventSource<In = unknown, Channel = never, Props = unknown> {
  "~alchemy/Kind": "EventSource";
  "~alchemy/Name": string;
  /** Who publishes this source; absent/`"org"` = org-internal. */
  "~alchemy/Owner"?: EventSourceOwner;
  /**
   * The source's readable name — an alias of `~alchemy/Name`. The
   * inert-mention escape hatch: `${X.name}` interpolates a plain string
   * (renders the name, grants nothing), where a bare `${X}` is the
   * publish grant.
   */
  name: string;
  /**
   * The term's rendered clause — a present-tense phrase completing
   * "when ___" (see {@link EventSourceOptions.description}). Composed
   * by the marked expressions (`AI.when(X)` → "when {description}";
   * the machine-observed exit `AI.exit(AI.when(X))` → the exit
   * clause); a bare mention still renders only the NAME (descriptions
   * never leak into noun position). `undefined` ⇒ the expressions fall
   * back to the name.
   */
  description?: string;
  /**
   * The source's natural identity key (see
   * {@link EventSourceOptions.key}) — the ONE correlation function the
   * front door steers by and the kernel settles machine-observed exits
   * by. `undefined` ⇒ keyless (front door always `send`s; an exit
   * settles on any event from the source).
   */
  key?: (payload: any) => string | undefined;
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
  // kernel-internal (channel-less) source with options: description/key
  // for org-internal families that still want the combinator contract
  <
    const Name extends string,
    Schema extends S.Top,
    const Owner extends EventSourceOwner,
  >(
    name: Name,
    schema: Schema,
    options: EventSourceOptions<Owner>,
  ): EventSource<Schema["Type"], never, undefined> & {
    "~alchemy/Owner": Owner;
  };
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
  // owner-marked (provider catalogs): the returned type narrows
  // `~alchemy/Owner` to the literal so Services.ts can gate the bare
  // mention at the type level (canon §2a ruling 4)
  <
    const Name extends string,
    Schema extends S.Top,
    Channel,
    const Props,
    const Owner extends EventSourceOwner,
  >(
    name: Name,
    schema: Schema,
    channel: Context.Service<Channel, EventChannelService>,
    props: Props,
    options: EventSourceOptions<Owner>,
  ): EventSource<Schema["Type"], Channel, Props> & {
    "~alchemy/Owner": Owner;
  };
} = (
  name: string,
  schema: S.Top,
  channelOrOptions?:
    | Context.Service<any, EventChannelService>
    | EventSourceOptions<EventSourceOwner>,
  props?: unknown,
  maybeOptions?: EventSourceOptions<EventSourceOwner>,
): any => {
  // a channel tag is a Context.Service class (typeof "function"); the
  // channel-less options overload passes a plain object in its place
  const [channel, options] =
    channelOrOptions !== undefined && typeof channelOrOptions === "object"
      ? [undefined, channelOrOptions as EventSourceOptions<EventSourceOwner>]
      : [
          channelOrOptions as
            | Context.Service<any, EventChannelService>
            | undefined,
          maybeOptions,
        ];
  return {
    "~alchemy/Kind": "EventSource",
    "~alchemy/Name": name,
    "~alchemy/Owner": options?.owner ?? "org",
    name,
    description: options?.description,
    key: options?.key,
    schema,
    channel,
    props,
  };
};

export const isEventSource = (
  value: unknown,
): value is EventSource<unknown, any, any> =>
  typeof value === "object" &&
  value !== null &&
  (value as Record<string, unknown>)["~alchemy/Kind"] === "EventSource";

/**
 * Is the source world-owned (canon §2a ruling 4)? A world-owned source's
 * bare mention is inert vocabulary — no publish grant, no `emits`
 * topology, and `ctx.emit` of it is a defect: a process cannot publish
 * what only the world emits.
 */
export const isWorldOwned = (source: EventSource<any, any, any>): boolean =>
  source["~alchemy/Owner"] === "world";
