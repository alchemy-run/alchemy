import type * as webhooks from "@distilled.cloud/e2b/webhooks";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { E2BError } from "./SandboxClient.ts";
import type { Webhook } from "./Webhook.ts";

/** A webhook's delivery history and stats. */
export interface WebhookClient {
  /** Deliveries grouped by event, newest first, with each attempt's request and response. */
  deliveries(
    options?: Omit<webhooks.ListWebhookDeliveriesRequest, "webhookID">,
  ): Effect.Effect<webhooks.WebhookDeliveriesListPayload, E2BError, RuntimeContext>;
  /** Delivery counts, failures and latency over time. */
  stats(
    options?: Omit<webhooks.GetWebhookStatsRequest, "webhookID">,
  ): Effect.Effect<webhooks.WebhookDeliveryStats, E2BError, RuntimeContext>;
}

/**
 * Read an E2B {@link Webhook}'s delivery history and stats: debug a failing
 * endpoint, or alert on failed deliveries.
 *
 * ### Reading deliveries
 * **Example:** Failed deliveries in the last hour
 * ```typescript
 * const hook = yield* E2B.ReadWebhook(Lifecycle);
 * // in fetch:
 * const failed = yield* hook.deliveries({ deliveryStatus: ["failed"] });
 * ```
 *
 * @binding
 * @product Webhook
 */
export interface ReadWebhook extends Binding.Service<
  ReadWebhook,
  "E2B.ReadWebhook",
  (webhook: Webhook) => Effect.Effect<WebhookClient>
> {}

export const ReadWebhook = Binding.Service<ReadWebhook>("E2B.ReadWebhook");
