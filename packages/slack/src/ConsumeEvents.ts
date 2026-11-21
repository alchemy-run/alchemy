import type { RuntimeContext } from "alchemy/RuntimeContext";
import { sanitizeKey } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AppManifest } from "./App.ts";

/** A message posted in a conversation the app can see. */
export interface MessageEvent {
  readonly type: "message";
  readonly channel: string;
  readonly channel_type?: "channel" | "group" | "im" | "mpim" | "app_home";
  readonly user?: string;
  readonly bot_id?: string;
  readonly text?: string;
  readonly ts: string;
  readonly thread_ts?: string;
  /** Set on edits, deletions, joins and other non-plain messages. */
  readonly subtype?: string;
  readonly event_ts: string;
}

/** The app's bot user was @-mentioned. */
export interface AppMentionEvent {
  readonly type: "app_mention";
  readonly channel: string;
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly thread_ts?: string;
  readonly event_ts: string;
}

/** A reaction was added to (or removed from) an item. */
export interface ReactionEvent {
  readonly type: "reaction_added" | "reaction_removed";
  readonly user: string;
  readonly reaction: string;
  readonly item_user?: string;
  readonly item: { readonly type: string; readonly channel?: string; readonly ts?: string };
  readonly event_ts: string;
}

/** A member joined (or left) a channel. */
export interface MembershipEvent {
  readonly type: "member_joined_channel" | "member_left_channel";
  readonly user: string;
  readonly channel: string;
  readonly channel_type?: string;
  readonly team?: string;
  readonly inviter?: string;
  readonly event_ts: string;
}

/** A user opened the app's Home tab. */
export interface AppHomeOpenedEvent {
  readonly type: "app_home_opened";
  readonly user: string;
  readonly channel: string;
  readonly tab: "home" | "messages";
  readonly event_ts: string;
}

/** Any other event type. */
export interface OtherEvent {
  readonly type: string;
  readonly event_ts?: string;
  readonly [field: string]: unknown;
}

/** Events with a typed payload, keyed by their `type`. */
export interface KnownEvents {
  message: MessageEvent;
  app_mention: AppMentionEvent;
  reaction_added: ReactionEvent;
  reaction_removed: ReactionEvent;
  member_joined_channel: MembershipEvent;
  member_left_channel: MembershipEvent;
  app_home_opened: AppHomeOpenedEvent;
}

/**
 * Events API subscription names: an event type (`app_mention`), or for
 * messages the conversation kind (`message.channels`, `message.im`, …).
 * @see https://docs.slack.dev/reference/events
 */
export type EventSubscription =
  | keyof KnownEvents
  | "message.channels"
  | "message.groups"
  | "message.im"
  | "message.mpim"
  | "message.app_home"
  | (string & {});

/** The event type a subscription delivers (`message.channels` → `message`). */
export type EventTypeOf<S extends string> = S extends `message.${string}` ? "message" : S;

/** The event payload for a list of subscriptions. */
export type SelectedEvent<S extends readonly EventSubscription[]> =
  EventTypeOf<S[number]> extends infer T
    ? T extends keyof KnownEvents
      ? KnownEvents[T]
      : OtherEvent
    : never;

/**
 * One Events API delivery (`event_callback`).
 * @see https://docs.slack.dev/apis/events-api/#callback-field
 */
export interface EventCallback<E = OtherEvent> {
  readonly type: "event_callback";
  /** Unique per event. Slack retries a delivery it saw fail; dedupe on this. */
  readonly event_id: string;
  readonly event_time: number;
  readonly team_id: string;
  readonly api_app_id: string;
  readonly event: E;
  readonly authorizations?: ReadonlyArray<{
    readonly team_id: string;
    readonly user_id: string;
    readonly is_bot: boolean;
  }>;
}

export interface ConsumeEventsProps<S extends readonly EventSubscription[]> {
  /**
   * The app that receives the events. `consumeEvents` creates it (as a
   * {@link App} inside the host) with its Events API `request_url` set to the
   * host. Don't set `settings.event_subscriptions` yourself.
   */
  manifest: AppManifest;
  /** Bot events to subscribe to. The app needs the scope each one requires. */
  events: S;
  /** Path on the host. @default "/slack/events" */
  path?: string;
}

export const eventsPath = (path?: string): string => path ?? "/slack/events";

/** Environment key the signing secret for `path` is bound under. */
export const signingSecretEnvName = (path?: string): string =>
  sanitizeKey(`SLACK_SIGNING_SECRET_${eventsPath(path)}`);

/**
 * Receive Slack Events API deliveries on the host.
 *
 * `consumeEvents` provisions the {@link App} itself: it creates the app from
 * `manifest` inside the host, points the app's Events API URL at the host,
 * subscribes the bot to `events`, and binds the app's signing secret into the
 * host so every delivery is verified (`X-Slack-Signature`). The app's
 * `url_verification` challenge is answered for you.
 *
 * Slack expects a 200 within 3 seconds and retries otherwise, so keep the
 * handler short and dedupe on `event_id`.
 *
 * Provide `Slack.ConsumeEventsLive` on the host's Effect, e.g. a Cloudflare
 * Worker.
 *
 * ### Handling events
 * **Example:** Reply when the bot is mentioned
 * ```typescript
 * yield* Slack.consumeEvents(
 *   "Bot",
 *   {
 *     manifest: {
 *       features: { bot_user: { display_name: "helper" } },
 *       oauth_config: { scopes: { bot: ["app_mentions:read", "chat:write"] } },
 *     },
 *     events: ["app_mention"],
 *   },
 *   Effect.fn(function* (delivery) {
 *     // delivery.event: AppMentionEvent
 *     yield* Effect.log(`${delivery.event.user}: ${delivery.event.text}`);
 *   }),
 * );
 * ```
 *
 * @binding
 * @product Events
 */
export function consumeEvents<const S extends readonly EventSubscription[], Req = never>(
  id: string,
  props: ConsumeEventsProps<S>,
  process: (
    delivery: EventCallback<SelectedEvent<S>>,
  ) => Effect.Effect<void, never, Req | RuntimeContext>,
): Effect.Effect<void, never, EventSource> {
  return EventSource.use((source) =>
    source(
      id,
      props as ConsumeEventsProps<readonly EventSubscription[]>,
      process as (delivery: EventCallback) => Effect.Effect<void, never, never>,
    ),
  );
}

export type EventSourceService = (
  id: string,
  props: ConsumeEventsProps<readonly EventSubscription[]>,
  process: (delivery: EventCallback) => Effect.Effect<void, never, never>,
) => Effect.Effect<void, never, never>;

export class EventSource extends Context.Service<EventSource, EventSourceService>()(
  "Slack.EventSource",
) {}
