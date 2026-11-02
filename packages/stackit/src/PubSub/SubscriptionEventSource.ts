import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { PulledMessage } from "./Pull.ts";
import type { Subscription } from "./Subscription.ts";

export interface SubscriptionEventSourceProps {
  /**
   * The most messages to take per pull, from 1 to 32. Handlers run on what a pull returned
   * before the next pull starts.
   * @default 10
   */
  maxMessages?: number;
  /**
   * How long one pull waits on the server when there are no messages, in milliseconds,
   * from 100 to 5000.
   * @default 5000
   */
  longPullDuration?: number;
  /**
   * How many handlers run at once.
   * @default 1
   */
  concurrency?: number;
}

/**
 * Handles one message. A success acknowledges it. A failure, or a defect, hands it back
 * for another delivery, and `deliveryAttempts` lets a handler give up on a poison message:
 * the service has no dead-letter topic, so succeeding is the only way to stop it coming back.
 * After a batch with a failure the host waits before it pulls again, from 1 second up to 30,
 * so a message that keeps failing slows the whole subscription until the handler gives up.
 */
export type SubscriptionMessageHandler<E = never, Req = never> = (
  message: PulledMessage,
) => Effect.Effect<void, E, Req>;

export type SubscriptionEventSourceService = <E = never, Req = never>(
  subscription: Subscription,
  props: SubscriptionEventSourceProps,
  process: SubscriptionMessageHandler<E, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting a subscription to a long-lived host. Pub/Sub only delivers when
 * asked and has no push endpoint, so nothing can invoke a function when a message arrives:
 * the host keeps pulling for its whole life. It fits a host that provides core's `ServerHost`
 * and keeps running, such as a `Docker.Service`, an ECS task or an EC2 instance. A Cloudflare
 * Worker has no `ServerHost`. A STACKIT Function has one, but STACKIT doesn't document
 * whether its instances keep running between requests, so don't rely on it for this; call
 * `Stackit.PubSub.Pull` from a request instead.
 *
 * Consume it through {@link consumeSubscriptionMessages}, and provide
 * `Stackit.PubSub.ServerSubscriptionEventSource`. The contract is a `Binding.Service`, so a
 * runtime with another way to consume can ship its own implementation layer.
 *
 * Delivery is at least once, so a handler can see a message twice: after a failed
 * acknowledgement, or when it runs longer than the subscription's `ackDeadline`. A message
 * whose `data` can't be decoded never reaches a handler: it is logged and acknowledged, since
 * it could never succeed.
 *
 * Access: a host signs with a service account key Alchemy creates for it, and Alchemy adds
 * that account to this subscription's subscribers through a
 * `Stackit.PubSub.SubscriptionSubscriberAccess`, so the grant covers this one subscription.
 * The topic's `acl` has to include the host's egress address, and it allows every address by
 * default.
 *
 * ### Consuming a Subscription
 * **Example:** A worker process for a subscription
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export const Orders = Stackit.PubSub.Topic("Orders", {});
 * export const Billing = Orders.pipe(
 *   Effect.flatMap((topic) =>
 *     Stackit.PubSub.Subscription("Billing", { topicId: topic.topicId }),
 *   ),
 * );
 *
 * export default class BillingWorker extends Docker.Service<BillingWorker>()(
 *   "BillingWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     yield* Stackit.PubSub.consumeSubscriptionMessages(
 *       Billing,
 *       { maxMessages: 32, concurrency: 8 },
 *       (message) => Effect.log(message.text),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(Stackit.PubSub.ServerSubscriptionEventSource)),
 * ) {}
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface SubscriptionEventSource extends Binding.Service<
  SubscriptionEventSource,
  "Stackit.PubSub.SubscriptionEventSource",
  SubscriptionEventSourceService
> {}

export const SubscriptionEventSource = Binding.Service<SubscriptionEventSource>(
  "Stackit.PubSub.SubscriptionEventSource",
);

/**
 * Subscribe an Effect handler to a subscription, for the host's whole life. A handler's
 * success acknowledges its message, and a failure hands it back for another delivery.
 *
 * @param subscription The subscription, or the Effect that declares it.
 * @param props How to pull.
 * @param process The message handler.
 */
export const consumeSubscriptionMessages = <E = never, Req = never, ResourceReq = never>(
  subscription: Subscription | Effect.Effect<Subscription, never, ResourceReq>,
  props: SubscriptionEventSourceProps,
  process: SubscriptionMessageHandler<E, Req>,
): Effect.Effect<void, never, SubscriptionEventSource | ResourceReq> =>
  (Effect.isEffect(subscription) ? subscription : Effect.succeed(subscription)).pipe(
    Effect.flatMap((value) =>
      SubscriptionEventSource.use((source) => source(value, props, process)),
    ),
  );
