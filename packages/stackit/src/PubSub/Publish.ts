import type * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Topic } from "./Topic.ts";

/** One message to publish. */
export interface PublishMessage {
  /** The payload: text, sent as UTF-8, or bytes. The binding base64-encodes it for the wire. */
  readonly data: string | Uint8Array;
}

export interface PublishRequest {
  /** The messages to publish. */
  readonly messages: ReadonlyArray<PublishMessage>;
}

/**
 * Runtime binding for Pub/Sub's data plane `publishMessages`: publish messages to a topic.
 *
 * Bind this operation to a {@link Topic} in a Function/Worker init phase and provide
 * {@link PublishHttp}. A batch over the service's size limit fails with the typed
 * `MessagesTooLarge`, which you can answer by splitting it.
 *
 * Access: this binding grants no role. A host signs with a service account key Alchemy
 * creates for it, and Alchemy adds that account to this topic's publishers through a
 * `Stackit.PubSub.TopicPublisherAccess`, so the grant covers this one topic. The topic's
 * `acl` has to include the host's egress address, and it allows every address by default.
 *
 * ### Publishing Messages
 * **Example:** Publish text from a Cloudflare Worker
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
 *     const publish = yield* Stackit.PubSub.Publish(yield* Orders);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* publish({
 *           messages: [{ data: JSON.stringify({ orderId: "1234" }) }],
 *         });
 *         return HttpServerResponse.text("published");
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.PublishHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface Publish extends Binding.Service<
  Publish,
  "Stackit.PubSub.Publish",
  (
    topic: Topic,
  ) => Effect.Effect<
    (
      request: PublishRequest,
    ) => Effect.Effect<
      pubsubData.PublishMessagesResponse,
      pubsubData.PublishMessagesError,
      RuntimeContext
    >
  >
> {}

export const Publish = Binding.Service<Publish>("Stackit.PubSub.Publish");
