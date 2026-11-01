import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { ConsumedMessage } from "./AmqpDriver.ts";
import type { Credential } from "./Credential.ts";

export interface QueueEventSourceProps {
  /** Queue to consume. A consumer that starts before the queue exists retries for a while. */
  queue: string;
  /**
   * Messages the broker hands out before earlier ones are finished, which is also how
   * many handlers run at once.
   * @default 1
   */
  prefetch?: number;
  /**
   * What happens to a message whose handler fails: back on the queue, or dropped
   * (dead-lettered, when the queue has a dead-letter exchange).
   * @default true
   */
  requeueOnFailure?: boolean;
}

/** Handles one message from the queue. A success acknowledges it. */
export type QueueMessageHandler<E = never, Req = never> = (
  message: ConsumedMessage,
) => Effect.Effect<void, E, Req>;

export type QueueEventSourceService = <E = never, Req = never>(
  credential: Credential,
  props: QueueEventSourceProps,
  process: QueueMessageHandler<E, Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source connecting a queue on a broker to a long-lived host. The broker can't
 * invoke anything, so the host keeps an AMQP consumer running for its whole life. It fits
 * a host that provides core's `ServerHost` and keeps running, such as a `Docker.Service`,
 * an ECS task or an EC2 instance. A Cloudflare Worker has no `ServerHost`. A STACKIT
 * Function has one, but STACKIT doesn't document whether its instances keep running
 * between requests, so don't rely on it for this.
 *
 * Consume it through {@link consumeQueueMessages}, and provide
 * `Stackit.RabbitMQ.ServerQueueEventSource`. The contract is a `Binding.Service`, so a
 * runtime with another way to consume can ship its own implementation layer.
 *
 * Install the optional peer `amqplib`. The host's egress IP has to be in the instance's
 * `acl`.
 *
 * ### Consuming a Queue
 * **Example:** A worker process for a queue
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 *
 * export const Broker = Stackit.RabbitMQ.Instance("Broker", {
 *   version: "4.1",
 *   planName: "stackit-rabbitmq-2.4.10-single",
 *   acl: ["0.0.0.0/0"],
 * });
 * export const App = Broker.pipe(
 *   Effect.flatMap((broker) =>
 *     Stackit.RabbitMQ.Credential("App", { instanceId: broker.instanceId }),
 *   ),
 * );
 *
 * export default class JobWorker extends Docker.Service<JobWorker>()(
 *   "JobWorker",
 *   { main: import.meta.filename },
 *   Effect.gen(function* () {
 *     yield* Stackit.RabbitMQ.consumeQueueMessages(
 *       App,
 *       { queue: "jobs", prefetch: 10 },
 *       (message) => Effect.log(message.text),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.ServerQueueEventSource)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface QueueEventSource extends Binding.Service<
  QueueEventSource,
  "Stackit.RabbitMQ.QueueEventSource",
  QueueEventSourceService
> {}

export const QueueEventSource = Binding.Service<QueueEventSource>(
  "Stackit.RabbitMQ.QueueEventSource",
);

/**
 * Subscribe an Effect handler to a queue, for the host's whole life. A handler's success
 * acknowledges its message, and a failure puts it back or drops it per `requeueOnFailure`.
 *
 * @param credential The credential to connect with, or the Effect that declares it.
 * @param props The queue, and how to consume it.
 * @param process The message handler.
 */
export const consumeQueueMessages = <E = never, Req = never, ResourceReq = never>(
  credential: Credential | Effect.Effect<Credential, never, ResourceReq>,
  props: QueueEventSourceProps,
  process: QueueMessageHandler<E, Req>,
): Effect.Effect<void, never, QueueEventSource | ResourceReq> =>
  (Effect.isEffect(credential) ? credential : Effect.succeed(credential)).pipe(
    Effect.flatMap((value) => QueueEventSource.use((source) => source(value, props, process))),
  );
