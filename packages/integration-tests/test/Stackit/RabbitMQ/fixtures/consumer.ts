import * as Docker from "@alchemy.run/docker";
import * as Stackit from "@alchemy.run/stackit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** Host port the swarm publishes the consumer on. Fixed, and uncommon on a shared daemon. */
export const CONSUMER_EXTERNAL_PORT = 43217;

/** The queue the event source consumes. */
export const EVENT_QUEUE = "alchemy-event-source-queue";

/** The queue `/consume` drains. */
export const DRAIN_QUEUE = "alchemy-consume-queue";

export const Instance = Stackit.RabbitMQ.Instance("RabbitMQConsumerInstance", {
  version: "4.1",
  planName: "stackit-rabbitmq-2.4.10-single",
  // The host connects from the machine running the suite, whatever its address.
  acl: ["0.0.0.0/0"],
});

export const AppCredential = Instance.pipe(
  Effect.flatMap((instance) =>
    Stackit.RabbitMQ.Credential("RabbitMQConsumerCredential", { instanceId: instance.instanceId }),
  ),
);

/**
 * A long-lived host with the AMQP bindings: an AMQP consumer needs a process that keeps
 * running, which a Worker isn't. The event source collects what it receives, `/received`
 * reports that, and `/consume` runs `Consume` for a bounded time and reports what it took.
 */
export default class RabbitMQConsumer extends Docker.Service<RabbitMQConsumer>()(
  "StackitRabbitMQConsumer",
  {
    main: import.meta.filename,
    port: 3000,
    ports: [{ external: CONSUMER_EXTERNAL_PORT, internal: 3000 }],
    replicas: 1,
  },
  Effect.gen(function* () {
    const credential = yield* AppCredential;
    const consume = yield* Stackit.RabbitMQ.Consume(credential);
    const received: string[] = [];

    yield* Stackit.RabbitMQ.consumeQueueMessages(
      credential,
      { queue: EVENT_QUEUE, prefetch: 5 },
      (message) =>
        Effect.sync(() => {
          received.push(message.text);
        }),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        switch (url.pathname) {
          case "/received":
            return yield* HttpServerResponse.json({ received });
          case "/consume": {
            const drained: string[] = [];
            const outcome = yield* consume({
              queue: DRAIN_QUEUE,
              prefetch: 5,
              handler: (message) =>
                Effect.sync(() => {
                  drained.push(message.text);
                }),
            }).pipe(Effect.timeoutOption("5 seconds"), Effect.exit);
            return yield* HttpServerResponse.json({
              drained,
              error: outcome._tag === "Failure" ? Cause.pretty(outcome.cause) : undefined,
            });
          }
          default:
            return HttpServerResponse.text("ok");
        }
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Stackit.RabbitMQ.ConsumeAmqp, Stackit.RabbitMQ.ServerQueueEventSource),
    ),
  ),
) {}
