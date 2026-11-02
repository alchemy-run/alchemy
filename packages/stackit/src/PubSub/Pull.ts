import type * as pubsubData from "@distilled.cloud/stackit/pubsub_data";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Subscription } from "./Subscription.ts";

export interface PullRequest {
  /**
   * The most messages to take, from 1 to 32.
   * @default 16
   */
  readonly maxMessages?: number;
  /**
   * How long to wait on the server for a message when there are none, in milliseconds,
   * from 100 to 5000.
   * @default 5000
   */
  readonly longPullDuration?: number;
}

/** A message taken from a subscription. */
export interface PulledMessage {
  /** The id to acknowledge the message with. */
  readonly ackId: string;
  /** The payload. */
  readonly data: Uint8Array;
  /** The payload decoded as UTF-8. */
  readonly text: string;
  /** When the message was created. */
  readonly createTime: string;
  /** How many times the message was delivered, this time included. */
  readonly deliveryAttempts: number;
}

/** A pulled message whose `data` wasn't the base64 the spec promises. */
export interface UndecodableMessage {
  /** The id to acknowledge it with, so that it stops coming back. */
  readonly ackId: string;
  /** How many times the message was delivered, this time included. */
  readonly deliveryAttempts: number;
  /** What was wrong with it. */
  readonly reason: string;
}

export interface PullResponse {
  /** The messages taken; empty when the wait ended with none. */
  readonly messages: ReadonlyArray<PulledMessage>;
  /** Messages taken that can't be decoded. They come back until they are acknowledged. */
  readonly undecodable: ReadonlyArray<UndecodableMessage>;
}

/**
 * Runtime binding for Pub/Sub's data plane `pullMessages`: take a batch of messages from a
 * subscription, waiting a few seconds when there are none.
 *
 * Bind this operation to a {@link Subscription} in a Function/Worker init phase and provide
 * {@link PullHttp}. Delivery is at least once: a message comes back after the subscription's
 * `ackDeadline` unless you pass its `ackId` to `Stackit.PubSub.Acknowledge`. To consume for
 * the whole life of a host, use `Stackit.PubSub.SubscriptionEventSource`.
 *
 * Access: this binding grants no role. A host signs with a service account key Alchemy
 * creates for it, and Alchemy adds that account to this subscription's subscribers through
 * a `Stackit.PubSub.SubscriptionSubscriberAccess`, so the grant covers this one
 * subscription. The topic's `acl` has to include the host's egress address, and it allows
 * every address by default.
 *
 * ### Pulling Messages
 * **Example:** Pull a batch from a Cloudflare Worker
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
 *     const pull = yield* Stackit.PubSub.Pull(yield* Billing);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const { messages } = yield* pull({ maxMessages: 10, longPullDuration: 1000 });
 *         return yield* HttpServerResponse.json(messages.map((message) => message.text));
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.PubSub.PullHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface Pull extends Binding.Service<
  Pull,
  "Stackit.PubSub.Pull",
  (
    subscription: Subscription,
  ) => Effect.Effect<
    (
      request?: PullRequest,
    ) => Effect.Effect<PullResponse, pubsubData.PullMessagesError, RuntimeContext>
  >
> {}

export const Pull = Binding.Service<Pull>("Stackit.PubSub.Pull");
