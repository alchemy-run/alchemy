import type * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Topic } from "./Topic.ts";

export interface DeleteSubscriptionRequest extends Omit<
  pubsub.DeleteSubscriptionRequest,
  "projectId" | "regionId" | "topicId"
> {}

/**
 * Runtime binding for Pub/Sub `deleteSubscription`: delete a subscription on a topic at runtime, by its id.
 *
 * Bind this operation to a {@link Topic} in a Function/Worker init phase and provide
 * {@link DeleteSubscriptionHttp}. The topic's project, region and id are injected into each request. It takes the id of any subscription on the topic, so don't use it on one a stack manages. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `pubsub.subscription.delete`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every subscription in the project.
 *
 * ### Deleting Subscriptions at Runtime
 * **Example:** Remove a tenant's subscription
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const deleteSubscription = yield* Stackit.PubSub.DeleteSubscription(yield* Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* deleteSubscription({ subscriptionId: "11111111-1111-1111-1111-111111111111" });
 *         return yield* HttpServerResponse.json({ deleted: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.DeleteSubscriptionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface DeleteSubscription extends Binding.Service<
  DeleteSubscription,
  "Stackit.PubSub.DeleteSubscription",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: DeleteSubscriptionRequest,
    ) => Effect.Effect<
      pubsub.DeleteSubscriptionResponse,
      pubsub.DeleteSubscriptionError,
      RuntimeContext
    >
  >
> {}

export const DeleteSubscription = Binding.Service<DeleteSubscription>(
  "Stackit.PubSub.DeleteSubscription",
);
