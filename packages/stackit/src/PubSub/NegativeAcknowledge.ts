import type * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

export interface NegativeAcknowledgeRequest extends Omit<
  pubsubData.NackMessagesRequest,
  "topicId" | "regionId" | "subscriptionId"
> {}

/**
 * Runtime binding for Pub/Sub's data plane `nackMessages`: hand pulled messages back, for
 * another delivery, instead of waiting for the subscription's `ackDeadline` to pass.
 *
 * Bind this operation to a {@link Subscription} in a Function/Worker init phase and provide
 * {@link NegativeAcknowledgeHttp}.
 *
 * Access: this binding grants no role. A host signs with a service account key Alchemy
 * creates for it, and Alchemy adds that account to this subscription's subscribers through
 * a `Stackit.PubSub.SubscriptionSubscriberAccess`, so the grant covers this one
 * subscription. The topic's `acl` has to include the host's egress address, and it allows
 * every address by default.
 *
 * ### Returning Messages
 * **Example:** Hand back a batch this Worker can't handle
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Layer from "effect/Layer";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 * export const Billing = Orders.pipe(
 *   Effect.flatMap((topic) =>
 *     Stackit.PubSub.Subscription("Billing", { topicId: topic.topicId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const billing = yield* Billing;
 *     const pull = yield* Stackit.PubSub.Pull(billing);
 *     const negativeAcknowledge = yield* Stackit.PubSub.NegativeAcknowledge(billing);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { messages } = yield* pull({ maxMessages: 10 });
 *         if (messages.length > 0) {
 *           yield* negativeAcknowledge({
 *             nackIds: messages.map((message) => message.ackId),
 *           });
 *         }
 *         return HttpServerResponse.text(`${messages.length} returned`);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(Stackit.PubSub.PullHttp, Stackit.PubSub.NegativeAcknowledgeHttp),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface NegativeAcknowledge extends Binding.Service<
  NegativeAcknowledge,
  "Stackit.PubSub.NegativeAcknowledge",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: NegativeAcknowledgeRequest,
    ) => Effect.Effect<
      pubsubData.NackMessagesResponse,
      pubsubData.NackMessagesError,
      RuntimeContext
    >
  >
> {}

export const NegativeAcknowledge = Binding.Service<NegativeAcknowledge>(
  "Stackit.PubSub.NegativeAcknowledge",
);
