import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toRedacted } from "../internal/dataServices.ts";
import { consume, type ConsumeOptions } from "./AmqpDriver.ts";
import { Consume } from "./Consume.ts";
import type { Credential } from "./Credential.ts";

/**
 * AMQP implementation of {@link Consume}, on the optional peer `amqplib`. One connection
 * per call, closed when the call ends.
 *
 * @layer
 * @provides Stackit.RabbitMQ.Consume
 * @peer amqplib
 */
export const ConsumeAmqp = Layer.succeed(
  Consume,
  Effect.fn(function* (credential: Credential) {
    const uri = yield* credential.uri;
    return <E = never, R = never>(options: ConsumeOptions<E, R>) =>
      Effect.flatMap(uri, (value) => consume(toRedacted(value), options));
  }),
);
