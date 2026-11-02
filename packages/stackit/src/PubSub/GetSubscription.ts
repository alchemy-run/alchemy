import type * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

export interface GetSubscriptionRequest extends Omit<
  pubsub.GetSubscriptionRequest,
  "projectId" | "regionId" | "topicId" | "subscriptionId"
> {}

/**
 * Runtime binding for Pub/Sub `getSubscription`: read a subscription's settings and state.
 *
 * Bind this operation to a {@link Subscription} in a Function/Worker init phase and provide
 * {@link GetSubscriptionHttp}. The subscription's project, region and ids are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `pubsub.subscription.get`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every subscription in the project.
 *
 * ### Reading the Subscription
 * **Example:** Read the subscription from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
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
 *     const getSubscription = yield* Stackit.PubSub.GetSubscription(yield* Billing);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getSubscription();
 *         return yield* HttpServerResponse.json({ state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.GetSubscriptionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface GetSubscription extends Binding.Service<
  GetSubscription,
  "Stackit.PubSub.GetSubscription",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request?: GetSubscriptionRequest,
    ) => Effect.Effect<pubsub.SubscriptionResponse, pubsub.GetSubscriptionError, RuntimeContext>
  >
> {}

export const GetSubscription = Binding.Service<GetSubscription>("Stackit.PubSub.GetSubscription");
