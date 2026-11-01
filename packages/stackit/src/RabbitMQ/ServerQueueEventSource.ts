import { ServerHost } from "alchemy/Runtime/Process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toRedacted } from "../internal/dataServices.ts";
import { consume, reconnecting } from "./AmqpDriver.ts";
import type { Credential } from "./Credential.ts";
import {
  QueueEventSource,
  type QueueEventSourceProps,
  type QueueEventSourceService,
  type QueueMessageHandler,
} from "./QueueEventSource.ts";

/**
 * {@link QueueEventSource} for a host with core's `ServerHost`: an AMQP consumer in a
 * background loop for the host's whole life, on the optional peer `amqplib`.
 *
 * @layer
 * @provides Stackit.RabbitMQ.QueueEventSource
 * @peer amqplib
 */
export const ServerQueueEventSource = Layer.effect(
  QueueEventSource,
  Effect.gen(function* () {
    const { run } = yield* ServerHost;
    // Cast below: the service type erases `process`'s requirements, so every event source
    // implementation casts its client.
    return Effect.fn(function* <E = never, Req = never>(
      credential: Credential,
      props: QueueEventSourceProps,
      process: QueueMessageHandler<E, Req>,
    ) {
      const uri = yield* credential.uri;
      yield* run(
        reconnecting((onConsuming) =>
          Effect.flatMap(uri, (value) =>
            consume(toRedacted(value), {
              queue: props.queue,
              prefetch: props.prefetch,
              requeueOnFailure: props.requeueOnFailure,
              handler: process,
              onConsuming,
            }),
          ),
        ).pipe(Effect.orDie),
      );
    }) as QueueEventSourceService;
  }),
);
