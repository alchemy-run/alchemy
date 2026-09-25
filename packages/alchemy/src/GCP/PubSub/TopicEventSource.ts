import type * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import * as Binding from "../../Binding.ts";
import type { Topic } from "./Topic.ts";

/** One delivered Pub/Sub message, as push and pull deliver it. */
export interface TopicMessage {
  /** The message: base64 `data`, `attributes`, `messageId`, `publishTime`. */
  message: pubsub.PubsubMessage;
  /** Subscription the message arrived on (`projects/p/subscriptions/s`). */
  subscription: string;
  /** Delivery attempt, when a dead-letter policy is configured. */
  deliveryAttempt: number | undefined;
}

export interface TopicEventSourceProps {
  /**
   * Seconds Pub/Sub waits for an ack (a 2xx push response, or an explicit
   * pull ack) before redelivering.
   * @default 60
   */
  ackDeadlineSeconds?: number;
  /**
   * Pub/Sub filter expression on message attributes; only matching
   * messages are delivered.
   */
  filter?: string;
  /**
   * Push delivery path on the host. Defaults to a deterministic
   * per-topic path under `/__alchemy/pubsub/`. Push hosts only.
   */
  path?: string;
  /**
   * Maximum messages per pull. Pull hosts only.
   * @default 10
   */
  maxMessages?: number;
}

export type TopicMessagesHandler<Req> = (
  messages: Stream.Stream<TopicMessage>,
) => Effect.Effect<void, never, Req>;

export type TopicEventSourceService = <Req = never>(
  topic: Topic,
  props: TopicEventSourceProps,
  process: TopicMessagesHandler<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting a Pub/Sub {@link Topic} to the hosting compute.
 *
 * The host-specific implementation layers are:
 *
 * - `GCP.Run.TopicEventSource` — push delivery to an HTTP host
 *   (`GCP.Run.Service` / `GCP.Function`, `GCP.CloudFunctions.Function`).
 *   Provisions a push subscription at the host's URL, authenticated with an
 *   OIDC token for the host's runtime service account, grants that account
 *   `roles/run.invoker` on the host, and verifies the token on every
 *   delivery. A 2xx response acks; a failed handler returns 500 and Pub/Sub
 *   redelivers.
 * - `GCP.Run.TopicPullEventSource` — a pull loop for hosts without an
 *   inbound URL (`GCP.Run.Job`, `GCP.Run.WorkerPool`). Provisions a pull
 *   subscription, grants `roles/pubsub.subscriber` on it, and acks each
 *   batch after the handler succeeds.
 *
 * Consume it through {@link consumeTopicMessages}.
 *
 * ### Consuming a Topic
 * **Example:** Push to a Cloud Run service
 * ```typescript
 * export class Worker extends GCP.Function<Worker>()(
 *   "Worker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const orders = yield* GCP.PubSub.Topic("Orders", {});
 *     yield* GCP.PubSub.consumeTopicMessages(orders, (messages) =>
 *       messages.pipe(
 *         Stream.runForEach(({ message }) =>
 *           Effect.log(atob(message.data ?? "")),
 *         ),
 *       ),
 *     );
 *   }).pipe(Effect.provide(GCP.Run.TopicEventSource)),
 * ) {}
 * ```
 *
 * **Example:** Pull from a worker pool
 * ```typescript
 * yield* GCP.PubSub.consumeTopicMessages(
 *   orders,
 *   { maxMessages: 50 },
 *   (messages) => messages.pipe(Stream.runForEach(handle)),
 * );
 * // …provided with Effect.provide(GCP.Run.TopicPullEventSource)
 * ```
 *
 * @binding
 * @category PubSub
 */
export interface TopicEventSource extends Binding.Service<
  TopicEventSource,
  "GCP.PubSub.TopicEventSource",
  TopicEventSourceService
> {}

export const TopicEventSource = Binding.Service<TopicEventSource>(
  "GCP.PubSub.TopicEventSource",
);

/**
 * Subscribe an Effect handler to messages published to a Pub/Sub
 * {@link Topic}. See {@link TopicEventSource} for the host implementations.
 */
export function consumeTopicMessages<Req = never>(
  topic: Topic,
  process: TopicMessagesHandler<Req>,
): Effect.Effect<void, never, TopicEventSource>;
export function consumeTopicMessages<Req = never>(
  topic: Topic,
  props: TopicEventSourceProps,
  process: TopicMessagesHandler<Req>,
): Effect.Effect<void, never, TopicEventSource>;
export function consumeTopicMessages<Req = never>(
  topic: Topic,
  propsOrProcess: TopicEventSourceProps | TopicMessagesHandler<Req>,
  maybeProcess?: TopicMessagesHandler<Req>,
): Effect.Effect<void, never, TopicEventSource> {
  const [props, process] =
    typeof propsOrProcess === "function"
      ? [{} as TopicEventSourceProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  return TopicEventSource.use((source) => source(topic, props, process));
}
