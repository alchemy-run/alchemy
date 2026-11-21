import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { WebhookEventType } from "./EventWebhook.ts";
import type { Providers } from "./Providers.ts";

/**
 * One webhook event Discord delivered
 * (https://discord.com/developers/docs/events/webhook-events#event-body-object).
 */
export interface WebhookEvent<T extends WebhookEventType = WebhookEventType> {
  /** Event type, e.g. `APPLICATION_AUTHORIZED`. */
  readonly type: T;
  /** When it happened, ISO 8601. */
  readonly timestamp: string;
  /**
   * The event's data: for `APPLICATION_AUTHORIZED`, `{ user, scopes,
   * integration_type, guild? }`; for entitlement events, the entitlement.
   */
  readonly data: unknown;
}

export interface WebhookEventsProps<T extends WebhookEventType = WebhookEventType> {
  /** Events to subscribe to. */
  types: ReadonlyArray<T>;
  /**
   * Path on the host Discord delivers to.
   * @default "/__alchemy/discord/events"
   */
  path?: string;
}

/**
 * Receive the application's webhook events (installs, deauthorizations,
 * entitlements, quests, lobby and game DM messages) on the host this runs in.
 *
 * Deploying it registers `${host.url}${path}` as the application's event
 * webhook URL with the selected types. Every delivery is verified against the
 * application's public key. The handler runs once per event; Discord expects
 * a 204 within 3 seconds and retries otherwise. Provide
 * `Discord.WebhookEventsLive`.
 *
 * ### Reacting to Installs
 * **Example:** Log new installs
 * ```typescript
 * yield* Discord.consumeWebhookEvents(
 *   { types: ["APPLICATION_AUTHORIZED"] },
 *   (event) => Effect.log(`installed: ${JSON.stringify(event.data)}`),
 * );
 * ```
 *
 * @binding
 * @product Interaction
 */
export const consumeWebhookEvents = <const T extends WebhookEventType, Req = never>(
  props: WebhookEventsProps<T>,
  handler: (event: WebhookEvent<T>) => Effect.Effect<void, never, Req | Providers>,
): Effect.Effect<void, never, WebhookEvents> =>
  WebhookEvents.use((source) =>
    source(props, handler as (event: WebhookEvent) => Effect.Effect<void, never, never>),
  );

export type WebhookEventsService = (
  props: WebhookEventsProps,
  handler: (event: WebhookEvent) => Effect.Effect<void, never, never>,
) => Effect.Effect<void, never, never>;

export class WebhookEvents extends Context.Service<WebhookEvents, WebhookEventsService>()(
  "Discord.WebhookEvents",
) {}

export const webhookEventsPath = (props: { path?: string }) =>
  props.path ?? "/__alchemy/discord/events";
