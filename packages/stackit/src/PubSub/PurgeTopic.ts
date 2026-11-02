import type * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Topic } from "./Topic.ts";

/**
 * Runtime binding for Pub/Sub's data plane `purgeTopic`: delete every message in a topic
 * and keep the topic. Every subscription on the topic loses them.
 *
 * Bind this operation to a {@link Topic} in a Function/Worker init phase and provide
 * {@link PurgeTopicHttp}.
 *
 * Access: this binding grants no role. A host signs with a service account key Alchemy
 * creates for it, and Alchemy adds that account to this topic's publishers through a
 * `Stackit.PubSub.TopicPublisherAccess`, so the grant covers this one topic. The topic's
 * `acl` has to include the host's egress address, and it allows every address by default.
 *
 * ### Purging a Topic
 * **Example:** Clear a topic from a Cloudflare Worker
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
 *     const purgeTopic = yield* Stackit.PubSub.PurgeTopic(yield* Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* purgeTopic();
 *         return HttpServerResponse.text("purged");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.PurgeTopicHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface PurgeTopic extends Binding.Service<
  PurgeTopic,
  "Stackit.PubSub.PurgeTopic",
  (
    topic: Topic,
  ) => Effect.Effect<
    () => Effect.Effect<pubsubData.PurgeTopicResponse, pubsubData.PurgeTopicError, RuntimeContext>
  >
> {}

export const PurgeTopic = Binding.Service<PurgeTopic>("Stackit.PubSub.PurgeTopic");
