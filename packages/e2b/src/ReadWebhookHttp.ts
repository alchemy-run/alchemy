import * as webhooks from "@distilled.cloud/e2b/webhooks";
import type * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { bindE2B } from "./E2BBindings.ts";
import { ReadWebhook, type WebhookClient } from "./ReadWebhook.ts";
import type { Webhook } from "./Webhook.ts";

/**
 * HTTP implementation of {@link ReadWebhook}. Works on any host.
 *
 * ### Provide the layer
 * **Example:** On a Worker
 * ```typescript
 * Effect.gen(function* () {
 *   const hook = yield* E2B.ReadWebhook(Lifecycle);
 *   // ...
 * }).pipe(Effect.provide(E2B.ReadWebhookHttp))
 * ```
 *
 * @layer
 * @product Webhook
 * @provides E2B.ReadWebhook
 */
export const ReadWebhookHttp = Layer.succeed(
  ReadWebhook,
  Effect.fn("E2B.ReadWebhook")(function* (webhook: Webhook) {
    const auth = yield* bindE2B;
    const webhookId = yield* (webhook.webhookId as Output.Output<string, never>).asEffect();
    const client: WebhookClient = {
      deliveries: (options) =>
        Effect.flatMap(webhookId, (id) =>
          auth.authorize(webhooks.listWebhookDeliveries({ ...options, webhookID: id })),
        ),
      stats: (options) =>
        Effect.flatMap(webhookId, (id) =>
          auth.authorize(webhooks.getWebhookStats({ ...options, webhookID: id })),
        ),
    };
    return client;
  }),
);
