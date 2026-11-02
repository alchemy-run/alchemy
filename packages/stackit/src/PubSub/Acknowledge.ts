import type * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

export interface AcknowledgeRequest extends Omit<
  pubsubData.AckMessagesRequest,
  "topicId" | "regionId" | "subscriptionId"
> {}

/**
 * Runtime binding for Pub/Sub's data plane `ackMessages`: confirm that pulled messages were
 * handled, so they aren't delivered again.
 *
 * Bind this operation to a {@link Subscription} in a Function/Worker init phase and provide
 * {@link AcknowledgeHttp}.
 *
 * Access: this binding grants no role. A host signs with a service account key Alchemy
 * creates for it, and Alchemy adds that account to this subscription's subscribers through
 * a `Stackit.PubSub.SubscriptionSubscriberAccess`, so the grant covers this one
 * subscription. The topic's `acl` has to include the host's egress address, and it allows
 * every address by default.
 *
 * ### Acknowledging Messages
 * **Example:** Pull a batch and acknowledge it from a Cloudflare Worker
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
 *     const acknowledge = yield* Stackit.PubSub.Acknowledge(billing);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { messages } = yield* pull({ maxMessages: 10 });
 *         if (messages.length > 0) {
 *           yield* acknowledge({ ackIds: messages.map((message) => message.ackId) });
 *         }
 *         return HttpServerResponse.text(`${messages.length} handled`);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(
 *     Effect.provide(
 *       Layer.mergeAll(Stackit.PubSub.PullHttp, Stackit.PubSub.AcknowledgeHttp),
 *     ),
 *   ),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface Acknowledge extends Binding.Service<
  Acknowledge,
  "Stackit.PubSub.Acknowledge",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request: AcknowledgeRequest,
    ) => Effect.Effect<pubsubData.AckMessagesResponse, pubsubData.AckMessagesError, RuntimeContext>
  >
> {}

export const Acknowledge = Binding.Service<Acknowledge>("Stackit.PubSub.Acknowledge");
