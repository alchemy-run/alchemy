import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Intake } from "./Intake.ts";
import type { KafkaConsumeOptions, KafkaError } from "./KafkaDriver.ts";
import type { User } from "./User.ts";

export type { ConsumedKafkaMessage } from "./KafkaDriver.ts";

/** How to read an intake's dead letter topic. */
export type ConsumeDeadLetterOptions<E, R> = Omit<KafkaConsumeOptions<E, R>, "topic">;

/**
 * Runtime binding to read an intake's dead letter topic over the Kafka protocol: the
 * messages it couldn't deliver, with what went wrong in their headers. The returned effect
 * holds a connection and runs `handler` per message until it is interrupted, or fails with
 * `KafkaError` when the driver gives up on the consumer. It never succeeds.
 *
 * A consumer needs a process that keeps running, so this is for hosts such as a
 * `Docker.Service`, an ECS task or a pod. On a runtime that only runs during a request, it
 * can only read for as long as the request lasts: bound it with `Effect.timeoutOption`, as
 * below. `kafkajs` isn't known to work on a Cloudflare Worker.
 *
 * STACKIT calls this topic temporary storage for debugging. It is not an event source: the
 * cloud doesn't push anything.
 *
 * `kafkajs` only consumes through a consumer group, so `groupId` is required. STACKIT's
 * docs don't say whether a `dead-letter` user may join one; if it can't, this fails with
 * `KafkaError`.
 *
 * Binding it passes the intake's endpoint and topic and the user's name and password into
 * the host's environment, with the password kept `Redacted`. It grants no STACKIT role and
 * creates no service account. Bind a user of type `dead-letter`. Provide
 * {@link ConsumeDeadLetterKafka}, and install the optional peer `kafkajs`.
 *
 * ### Reading Dead Letters
 * **Example:** Log dead letters for 30 seconds on each request
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ingest = Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 * export const Events = Ingest.pipe(
 *   Effect.flatMap((runner) =>
 *     Stackit.Intake.Intake("Events", {
 *       runnerId: runner.runnerId,
 *       catalog: { uri: "https://iceberg.example.com/catalog", warehouse: "lake" },
 *     }),
 *   ),
 * );
 * export const DeadLetters = Events.pipe(
 *   Effect.flatMap((events) =>
 *     Stackit.Intake.User("DeadLetters", {
 *       intakeId: events.intakeId,
 *       type: "dead-letter",
 *       password: "replace-with-a-secret-Pw1!",
 *     }),
 *   ),
 * );
 *
 * export default class Debugger extends Docker.Service<Debugger>()(
 *   "Debugger",
 *   { main: import.meta.filename, port: 3000 },
 *   Effect.gen(function* () {
 *     const events = yield* Events;
 *     const reader = yield* DeadLetters;
 *     const consume = yield* Stackit.Intake.ConsumeDeadLetter(events, reader);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* consume({
 *           groupId: "debugger",
 *           handler: (message) => Effect.log(message.text, message.headers),
 *         }).pipe(Effect.timeoutOption("30 seconds"));
 *         return yield* HttpServerResponse.json({ done: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.ConsumeDeadLetterKafka)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Intake
 * @category Intake
 */
export interface ConsumeDeadLetter extends Binding.Service<
  ConsumeDeadLetter,
  "Stackit.Intake.ConsumeDeadLetter",
  (
    intake: Intake,
    user: User,
  ) => Effect.Effect<
    <E = never, R = never>(
      options: ConsumeDeadLetterOptions<E, R>,
    ) => Effect.Effect<never, KafkaError, R | RuntimeContext>
  >
> {}

export const ConsumeDeadLetter = Binding.Service<ConsumeDeadLetter>(
  "Stackit.Intake.ConsumeDeadLetter",
);
