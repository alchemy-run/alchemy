import type * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Topic } from "./Topic.ts";

export interface GetTopicRequest extends Omit<
  pubsub.GetTopicRequest,
  "projectId" | "regionId" | "topicId"
> {}

/**
 * Runtime binding for Pub/Sub `getTopic`: read a topic's settings, state and URI.
 *
 * Bind this operation to a {@link Topic} in a Function/Worker init phase and provide
 * {@link GetTopicHttp}. The topic's project, region and id are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `pubsub.topic.get`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every topic in the project.
 *
 * ### Reading the Topic
 * **Example:** Read the topic from a Cloudflare Worker
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
 *     const getTopic = yield* Stackit.PubSub.GetTopic(yield* Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const live = yield* getTopic();
 *         return yield* HttpServerResponse.json({ state: live.state });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.GetTopicHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface GetTopic extends Binding.Service<
  GetTopic,
  "Stackit.PubSub.GetTopic",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: GetTopicRequest,
    ) => Effect.Effect<pubsub.TopicResponse, pubsub.GetTopicError, RuntimeContext>
  >
> {}

export const GetTopic = Binding.Service<GetTopic>("Stackit.PubSub.GetTopic");
