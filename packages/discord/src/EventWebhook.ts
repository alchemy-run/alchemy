import * as discord from "@distilled.cloud/discord/discord";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { retryUnverifiedEndpoint } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

/**
 * Webhook event types an application can subscribe to
 * (https://discord.com/developers/docs/events/webhook-events#event-types).
 */
export type WebhookEventType =
  | "APPLICATION_AUTHORIZED"
  | "APPLICATION_DEAUTHORIZED"
  | "ENTITLEMENT_CREATE"
  | "ENTITLEMENT_UPDATE"
  | "ENTITLEMENT_DELETE"
  | "QUEST_USER_ENROLLMENT"
  | "LOBBY_MESSAGE_CREATE"
  | "LOBBY_MESSAGE_UPDATE"
  | "LOBBY_MESSAGE_DELETE"
  | "GAME_DIRECT_MESSAGE_CREATE"
  | "GAME_DIRECT_MESSAGE_UPDATE"
  | "GAME_DIRECT_MESSAGE_DELETE";

export interface EventWebhookProps {
  /**
   * HTTPS URL Discord POSTs webhook events to. Discord sends a signed PING
   * when it is set and refuses a URL that doesn't answer it.
   */
  url: string;
  /** Events to deliver. */
  types: WebhookEventType[];
  /** Whether deliveries are on. @default true */
  enabled?: boolean;
}

export interface EventWebhookAttributes {
  /** Application id. */
  applicationId: string;
  /** Registered URL. */
  url: string;
  /** Subscribed event types. */
  types: string[];
  /** Hex Ed25519 public key events are signed with. */
  publicKey: string;
}

/**
 * The application's webhook events subscription: Discord POSTs events such
 * as `APPLICATION_AUTHORIZED` and `ENTITLEMENT_CREATE` to a URL, signed with
 * the application's public key.
 *
 * `Discord.consumeWebhookEvents` declares this for you, pointing at the host
 * it runs on. Destroy turns deliveries off and clears the URL.
 *
 * ### Subscribing to Events
 * **Example:** Install and purchase events to your own endpoint
 * ```typescript
 * yield* Discord.EventWebhook("Events", {
 *   url: Output.interpolate`${worker.url}/discord-events`,
 *   types: ["APPLICATION_AUTHORIZED", "ENTITLEMENT_CREATE"],
 * });
 * ```
 *
 * @resource
 * @product Interaction
 */
export interface EventWebhook extends Resource<
  "Discord.EventWebhook",
  EventWebhookProps,
  EventWebhookAttributes,
  never,
  Providers
> {}

export const EventWebhook = Resource<EventWebhook>("Discord.EventWebhook");

const toAttributes = (app: discord.PrivateApplicationResponse): EventWebhookAttributes => ({
  applicationId: app.id,
  url: app.event_webhooks_url ?? "",
  types: [...(app.event_webhooks_types ?? [])],
  publicKey: app.verify_key,
});

/** 1 disabled, 2 enabled, 3 disabled by Discord after repeated failures. */
const ENABLED = 2;
const DISABLED = 1;

export const EventWebhookProvider = () =>
  Provider.succeed(EventWebhook, {
    nuke: { singleton: true },
    stables: ["applicationId", "publicKey"],

    read: Effect.fn(function* () {
      const app = yield* discord.getMyApplication({});
      return app.event_webhooks_url ? toAttributes(app) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const app = yield* discord.getMyApplication({});
      const status = (news.enabled ?? true) ? ENABLED : DISABLED;
      const types = [...news.types].sort();
      if (
        app.event_webhooks_url === news.url &&
        Number(app.event_webhooks_status) === status &&
        [...(app.event_webhooks_types ?? [])].sort().join() === types.join()
      ) {
        return toAttributes(app);
      }
      // Discord answers an event URL it couldn't verify with Invalid Form Body.
      const updated = yield* retryUnverifiedEndpoint(["InvalidFormBody"])(
        discord.updateMyApplication({
          event_webhooks_url: news.url,
          event_webhooks_status: status,
          event_webhooks_types: types as discord.UpdateMyApplicationRequest["event_webhooks_types"],
        }),
      );
      return toAttributes(updated);
    }),

    delete: Effect.fn(function* ({ output }) {
      const app = yield* discord.getMyApplication({});
      if (app.event_webhooks_url !== output.url) return;
      yield* discord.updateMyApplication({
        event_webhooks_status: DISABLED,
        event_webhooks_url: null,
        event_webhooks_types: [],
      });
    }),

    list: () => Effect.succeed([]),
  });
