import * as boat from "@distilled.cloud/boat-dev/boat";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { boatName, isGeneratedName } from "./internal/Ownership.ts";
import type { Providers } from "./Providers.ts";

/** A sandbox lifecycle event Boat delivers. */
export type WebhookEvent =
  | "sandbox.ready"
  | "sandbox.hydrated"
  | "sandbox.error"
  | "sandbox.archived"
  | "sandbox.degraded"
  | "sandbox.recovered";

/** Every sandbox lifecycle event Boat sends. */
export const ALL_SANDBOX_EVENTS: ReadonlyArray<WebhookEvent> = [
  "sandbox.ready",
  "sandbox.hydrated",
  "sandbox.error",
  "sandbox.archived",
  "sandbox.degraded",
  "sandbox.recovered",
];

export interface WebhookProps {
  /** The public HTTPS endpoint (port 443) Boat POSTs events to. Updated in place. */
  url: string;
  /** The events to deliver. Updated in place. */
  events: WebhookEvent[];
  /**
   * Display name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Renamed in place.
   */
  name?: string;
}

export interface WebhookAttributes {
  /** Boat's webhook id (`wh_…`). */
  webhookId: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  /**
   * The secret Boat signs deliveries with. Boat shows it once, at creation;
   * Alchemy keeps it in state.
   */
  secret: Redacted.Redacted<string>;
}

export interface Webhook extends Resource<
  "Boat.Webhook",
  WebhookProps,
  WebhookAttributes,
  never,
  Providers
> {}

/**
 * A Boat webhook: Boat POSTs sandbox lifecycle events (`sandbox.ready`,
 * `sandbox.error`, `sandbox.archived`, `sandbox.hydrated`,
 * `sandbox.degraded`, `sandbox.recovered`) to your endpoint, signed with
 * `secret`.
 *
 * ### Receiving sandbox events
 * **Example:** Deliver events to a Worker
 * ```typescript
 * const receiver = yield* Receiver;
 * const hook = yield* Boat.Webhook("Events", {
 *   url: Output.interpolate`${receiver.url}/boat`,
 *   events: ["sandbox.ready", "sandbox.archived"],
 * });
 * ```
 *
 * @resource
 * @product Webhook
 */
export const Webhook = Resource<Webhook>("Boat.Webhook");

const redact = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

const observeWebhook = (webhookId: string) =>
  boat.getWebhook({ webhookId }).pipe(
    Effect.map((got): boat.Webhook | undefined => got.webhook),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

const toAttributes = (
  webhook: boat.Webhook,
  secret: Redacted.Redacted<string>,
): WebhookAttributes => ({
  webhookId: webhook.id,
  name: webhook.name ?? "",
  url: webhook.url,
  events: [...webhook.events],
  secret,
});

const sameEvents = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export const WebhookProvider = () =>
  Provider.effect(
    Webhook,
    Effect.gen(function* () {
      return {
        stables: ["webhookId"],
        read: Effect.fn(function* ({ olds, output }) {
          // Boat shows the signing secret only at creation, so a webhook is
          // only usable through state.
          if (output === undefined) return undefined;
          const webhook = yield* observeWebhook(output.webhookId);
          if (webhook === undefined) return undefined;
          const attrs = toAttributes(webhook, output.secret);
          return olds !== undefined || isGeneratedName(webhook.name) ? attrs : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* boatName(id, news.name ?? output?.name, 100);

          // Observe
          let webhook = output === undefined ? undefined : yield* observeWebhook(output.webhookId);

          // Ensure
          if (webhook === undefined || output === undefined) {
            yield* session.note(`Creating webhook ${name}...`);
            const created = yield* boat.createWebhook({ name, url: news.url, events: news.events });
            return toAttributes(created.webhook, redact(created.secret));
          }

          // Sync — name, URL and events, against what Boat reports.
          if (
            webhook.name !== name ||
            webhook.url !== news.url ||
            !sameEvents(webhook.events, news.events)
          ) {
            const updated = yield* boat.updateWebhook({
              webhookId: webhook.id,
              name,
              url: news.url,
              events: news.events,
            });
            webhook = updated.webhook;
          }
          return toAttributes(webhook, output.secret);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* boat
            .deleteWebhook({ webhookId: output.webhookId })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
        list: Effect.fn(function* () {
          const listed = yield* boat.listWebhooks({});
          return listed.webhooks
            .filter((webhook) => isGeneratedName(webhook.name))
            .map((webhook) => toAttributes(webhook, Redacted.make("")));
        }),
      };
    }),
  );
