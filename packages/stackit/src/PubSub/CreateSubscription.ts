import type * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Topic } from "./Topic.ts";

export interface CreateSubscriptionRequest extends Omit<
  pubsub.CreateSubscriptionRequest,
  "projectId" | "regionId" | "topicId"
> {}

/**
 * Runtime binding for Pub/Sub `createSubscription`: create a subscription on a topic at runtime, such as one per tenant.
 *
 * Bind this operation to a {@link Topic} in a Function/Worker init phase and provide
 * {@link CreateSubscriptionHttp}. The topic's project, region and id are injected into each request. Stack deploys don't track what it creates, and deleting the topic deletes those subscriptions too. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `pubsub.subscription.create`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every topic in the project.
 *
 * ### Creating Subscriptions at Runtime
 * **Example:** One subscription per tenant
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
 *     const createSubscription = yield* Stackit.PubSub.CreateSubscription(yield* Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const created = yield* createSubscription({ displayName: "tenant-a" });
 *         return yield* HttpServerResponse.json({ subscriptionId: created.id });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.CreateSubscriptionHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface CreateSubscription extends Binding.Service<
  CreateSubscription,
  "Stackit.PubSub.CreateSubscription",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: CreateSubscriptionRequest,
    ) => Effect.Effect<pubsub.SubscriptionResponse, pubsub.CreateSubscriptionError, RuntimeContext>
  >
> {}

export const CreateSubscription = Binding.Service<CreateSubscription>(
  "Stackit.PubSub.CreateSubscription",
);
