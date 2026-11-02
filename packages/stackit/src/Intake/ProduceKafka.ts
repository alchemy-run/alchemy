import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toRedacted } from "../internal/dataServices.ts";
import type { Intake } from "./Intake.ts";
import { produce } from "./KafkaDriver.ts";
import { Produce, type ProduceRequest } from "./Produce.ts";
import type { User } from "./User.ts";

/**
 * Kafka implementation of {@link Produce}, on the optional peer `kafkajs`. One connection
 * per call, closed when the call ends.
 *
 * @layer
 * @provides Stackit.Intake.Produce
 * @peer kafkajs
 */
export const ProduceKafka = Layer.succeed(
  Produce,
  Effect.fn(function* (intake: Intake, user: User) {
    const uri = yield* intake.uri;
    const topic = yield* intake.topic;
    const username = yield* user.user;
    const password = yield* user.password;
    return Effect.fn(`Stackit.Intake.Produce(${intake.LogicalId})`)(function* (
      request: ProduceRequest,
    ) {
      const endpoint = yield* uri;
      const target = yield* topic;
      const name = yield* username;
      const secret = yield* password;
      return yield* produce(
        { uri: endpoint, user: name, password: toRedacted(secret) },
        target,
        request.messages,
      );
    });
  }),
);
