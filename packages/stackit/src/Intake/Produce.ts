import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Intake } from "./Intake.ts";
import type { KafkaError, ProducedMessage, ProducedRecord } from "./KafkaDriver.ts";
import type { User } from "./User.ts";

export type { KafkaError, ProducedMessage, ProducedRecord } from "./KafkaDriver.ts";

export interface ProduceRequest {
  /**
   * Messages to publish. An intake takes JSON, and sends anything else to its dead letter
   * topic. A message can't be larger than the runner's `maxMessageSizeKiB`.
   */
  messages: ReadonlyArray<ProducedMessage>;
}

/**
 * Runtime binding to publish messages to an intake's topic over the Kafka protocol. The
 * intake flushes them into its Iceberg table about five minutes later.
 *
 * Each call opens a connection and closes it when it ends, so nothing is held between
 * requests. That costs a TLS and SASL handshake per call, so send many messages in one
 * call rather than one call per message.
 *
 * This needs a host that can open TCP sockets with `node:net` and `node:tls`, such as a
 * `Docker.Service`, an ECS task, a pod or a Lambda. `kafkajs` isn't known to work on a
 * Cloudflare Worker.
 *
 * Binding it passes the intake's endpoint and topic and the user's name and password into
 * the host's environment, with the password kept `Redacted`. It grants no STACKIT role and
 * creates no service account: the broker takes the user's SASL credentials. Bind a user of
 * type `intake`. Provide {@link ProduceKafka}, and install the optional peer `kafkajs`.
 *
 * ### Publishing Messages
 * **Example:** Publish JSON from a long-running host
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
 * export const Producer = Events.pipe(
 *   Effect.flatMap((events) =>
 *     Stackit.Intake.User("Producer", {
 *       intakeId: events.intakeId,
 *       password: "replace-with-a-secret-Pw1!",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Docker.Service<Api>()(
 *   "Api",
 *   { main: import.meta.filename, port: 3000 },
 *   Effect.gen(function* () {
 *     const events = yield* Events;
 *     const producer = yield* Producer;
 *     const produce = yield* Stackit.Intake.Produce(events, producer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const records = yield* produce({
 *           messages: [{ key: "order-1", value: JSON.stringify({ total: 12 }) }],
 *         });
 *         return yield* HttpServerResponse.json({ records });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.ProduceKafka)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Intake
 * @category Intake
 */
export interface Produce extends Binding.Service<
  Produce,
  "Stackit.Intake.Produce",
  (
    intake: Intake,
    user: User,
  ) => Effect.Effect<
    (
      request: ProduceRequest,
    ) => Effect.Effect<ReadonlyArray<ProducedRecord>, KafkaError, RuntimeContext>
  >
> {}

export const Produce = Binding.Service<Produce>("Stackit.Intake.Produce");
