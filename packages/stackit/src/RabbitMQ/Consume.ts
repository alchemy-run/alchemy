import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AmqpError, ConsumeOptions } from "./AmqpDriver.ts";
import type { Credential } from "./Credential.ts";

export type { AmqpError, ConsumedMessage, ConsumeOptions } from "./AmqpDriver.ts";

/**
 * Runtime binding to consume a queue over AMQP. The returned effect holds a connection
 * and runs `handler` per message until it is interrupted, or fails with `AmqpError` when
 * the connection or the consumer is lost. It never succeeds.
 *
 * A consumer needs a process that keeps running, so this is for hosts such as a
 * `Docker.Service`, an ECS task or a pod. On a runtime that only runs during a request, it
 * can only drain a queue for as long as the request lasts. To run a consumer for a host's
 * whole life, use `Stackit.RabbitMQ.consumeQueueMessages`.
 *
 * A handler's success acknowledges its message. A failure is logged, and the message goes
 * back on the queue or is dropped, per `requeueOnFailure`. A message that always fails
 * comes back forever unless the queue has a delivery limit or `requeueOnFailure` is off.
 *
 * Binding it passes the credential's AMQP URI into the host's environment, kept
 * `Redacted`. It grants no STACKIT role. The host's egress IP has to be in the instance's
 * `acl`. Provide {@link ConsumeAmqp}, and install the optional peer `amqplib`.
 *
 * ### Consuming a Queue
 * **Example:** Drain a queue for 30 seconds on each request
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
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
 * export default class Drainer extends Docker.Service<Drainer>()(
 *   "Drainer",
 *   { main: import.meta.filename, port: 3000 },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const consume = yield* Stackit.RabbitMQ.Consume(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* consume({
 *           queue: "jobs",
 *           prefetch: 10,
 *           handler: (message) => Effect.log(message.text),
 *         }).pipe(Effect.timeoutOption("30 seconds"));
 *         return yield* HttpServerResponse.json({ drained: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.RabbitMQ.ConsumeAmqp)),
 * ) {}
 * ```
 *
 * @binding
 * @category RabbitMQ
 */
export interface Consume extends Binding.Service<
  Consume,
  "Stackit.RabbitMQ.Consume",
  (
    credential: Credential,
  ) => Effect.Effect<
    <E = never, R = never>(
      options: ConsumeOptions<E, R>,
    ) => Effect.Effect<never, AmqpError, R | RuntimeContext>
  >
> {}

export const Consume = Binding.Service<Consume>("Stackit.RabbitMQ.Consume");
