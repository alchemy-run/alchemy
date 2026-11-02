import type * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Topic } from "./Topic.ts";

export interface ListSubscriptionsRequest extends Omit<
  pubsub.ListSubscriptionsRequest,
  "projectId" | "regionId" | "topicId"
> {}

/**
 * Runtime binding for Pub/Sub `listSubscriptions`: list the subscriptions on a topic, one page at a time.
 *
 * Bind this operation to a {@link Topic} in a Function/Worker init phase and provide
 * {@link ListSubscriptionsHttp}. The topic's project, region and id are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `pubsub.subscription.list`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every subscription in the project.
 *
 * ### Listing Subscriptions
 * **Example:** List a topic's subscriptions from a Cloudflare Worker
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
 *     const listSubscriptions = yield* Stackit.PubSub.ListSubscriptions(yield* Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const listed = yield* listSubscriptions({ pageSize: 100 });
 *         return yield* HttpServerResponse.json({
 *           names: listed.subscriptions.map((item) => item.displayName),
 *           nextPageToken: listed.nextPageToken,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.ListSubscriptionsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface ListSubscriptions extends Binding.Service<
  ListSubscriptions,
  "Stackit.PubSub.ListSubscriptions",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: ListSubscriptionsRequest,
    ) => Effect.Effect<
      pubsub.ListSubscriptionsResponse,
      pubsub.ListSubscriptionsError,
      RuntimeContext
    >
  >
> {}

export const ListSubscriptions = Binding.Service<ListSubscriptions>(
  "Stackit.PubSub.ListSubscriptions",
);
