import type * as pubsub from "@distilled.cloud/stackit/pubsub";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Topic } from "./Topic.ts";

export interface ListTopicsRequest extends Omit<
  pubsub.ListTopicsRequest,
  "projectId" | "regionId"
> {}

/**
 * Runtime binding for Pub/Sub `listTopics`: list the topics in the same project and region as the bound one, one page at a time.
 *
 * Bind this operation to a {@link Topic} in a Function/Worker init phase and provide
 * {@link ListTopicsHttp}. The topic's project and region are injected into each request. A host signs with a service account key Alchemy
 * creates for it.
 *
 * Access: a custom role holding `pubsub.topic.list`, the permission the API's spec names. STACKIT
 * binds roles on projects at the narrowest, so the role reaches every topic in the project.
 *
 * ### Listing Topics
 * **Example:** List the sibling topics from a Cloudflare Worker
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
 *     const listTopics = yield* Stackit.PubSub.ListTopics(yield* Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const listed = yield* listTopics({ pageSize: 100 });
 *         return yield* HttpServerResponse.json({
 *           names: listed.topics.map((item) => item.displayName),
 *           nextPageToken: listed.nextPageToken,
 *         });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.ListTopicsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface ListTopics extends Binding.Service<
  ListTopics,
  "Stackit.PubSub.ListTopics",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request?: ListTopicsRequest,
    ) => Effect.Effect<pubsub.ListTopicsResponse, pubsub.ListTopicsError, RuntimeContext>
  >
> {}

export const ListTopics = Binding.Service<ListTopics>("Stackit.PubSub.ListTopics");
