import type * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

export interface ListSubscriptionSubscribersRequest extends Omit<
  pubsub.ListSubscriptionSubscribersRequest,
  "projectId" | "regionId" | "topicId" | "subscriptionId"
> {}

/**
 * Runtime binding for Pub/Sub `listSubscriptionSubscribers`: list the addresses allowed to pull from a subscription.
 *
 * Bind this operation to a {@link Subscription} in a Function/Worker init phase and provide
 * {@link ListSubscriptionSubscribersHttp}. The subscription's project, region and ids are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `pubsub.subscription.subscriber.list`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches the subscribers of every subscription in the project.
 *
 * ### Auditing Subscribers
 * **Example:** Report who may pull from a Cloudflare Worker
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
 *     const listSubscriptionSubscribers = yield* Stackit.PubSub.ListSubscriptionSubscribers(yield* Billing);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { emailAddresses } = yield* listSubscriptionSubscribers();
 *         return yield* HttpServerResponse.json({ emailAddresses });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.ListSubscriptionSubscribersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface ListSubscriptionSubscribers extends Binding.Service<
  ListSubscriptionSubscribers,
  "Stackit.PubSub.ListSubscriptionSubscribers",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request?: ListSubscriptionSubscribersRequest,
    ) => Effect.Effect<
      pubsub.ListEmailAddressesResponse,
      pubsub.ListSubscriptionSubscribersError,
      RuntimeContext
    >
  >
> {}

export const ListSubscriptionSubscribers = Binding.Service<ListSubscriptionSubscribers>(
  "Stackit.PubSub.ListSubscriptionSubscribers",
);
