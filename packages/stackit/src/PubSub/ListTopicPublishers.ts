import type * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Topic } from "./Topic.ts";

export interface ListTopicPublishersRequest extends Omit<
  pubsub.ListTopicPublishersRequest,
  "projectId" | "regionId" | "topicId"
> {}

/**
 * Runtime binding for Pub/Sub `listTopicPublishers`: list the addresses allowed to publish to a topic.
 *
 * Bind this operation to a {@link Topic} in a Function/Worker init phase and provide
 * {@link ListTopicPublishersHttp}. The topic's project, region and id are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `pubsub.topic.publisher.list`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches the publishers of every topic in the project.
 *
 * ### Auditing Publishers
 * **Example:** Report who may publish from a Cloudflare Worker
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
 *     const listTopicPublishers = yield* Stackit.PubSub.ListTopicPublishers(yield* Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { emailAddresses } = yield* listTopicPublishers();
 *         return yield* HttpServerResponse.json({ emailAddresses });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.ListTopicPublishersHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface ListTopicPublishers extends Binding.Service<
  ListTopicPublishers,
  "Stackit.PubSub.ListTopicPublishers",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: ListTopicPublishersRequest,
    ) => Effect.Effect<
      pubsub.ListEmailAddressesResponse,
      pubsub.ListTopicPublishersError,
      RuntimeContext
    >
  >
> {}

export const ListTopicPublishers = Binding.Service<ListTopicPublishers>(
  "Stackit.PubSub.ListTopicPublishers",
);
