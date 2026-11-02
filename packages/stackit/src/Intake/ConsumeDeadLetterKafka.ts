import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { toRedacted } from "../internal/dataServices.ts";
import { ConsumeDeadLetter, type ConsumeDeadLetterOptions } from "./ConsumeDeadLetter.ts";
import type { Intake } from "./Intake.ts";
import { consume } from "./KafkaDriver.ts";
import type { User } from "./User.ts";

/**
 * Kafka implementation of {@link ConsumeDeadLetter}, on the optional peer `kafkajs`. One
 * connection per call, closed when the call ends.
 *
 * @layer
 * @provides Stackit.Intake.ConsumeDeadLetter
 * @peer kafkajs
 */
export const ConsumeDeadLetterKafka = Layer.succeed(
  ConsumeDeadLetter,
  Effect.fn(function* (intake: Intake, user: User) {
    const uri = yield* intake.uri;
    const topic = yield* intake.deadLetterTopic;
    const username = yield* user.user;
    const password = yield* user.password;
    return <E = never, R = never>(options: ConsumeDeadLetterOptions<E, R>) =>
      Effect.gen(function* () {
        const endpoint = yield* uri;
        const target = yield* topic;
        const name = yield* username;
        const secret = yield* password;
        return yield* consume(
          { uri: endpoint, user: name, password: toRedacted(secret) },
          { ...options, topic: target },
        );
      });
  }),
);
