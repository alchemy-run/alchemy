import * as Docker from "@alchemy.run/docker";
import * as Stackit from "@alchemy.run/stackit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { CAPACITY, CATALOG, PASSWORD } from "./constants.ts";

/** Host port the swarm publishes the host on. Fixed, and uncommon on a shared daemon. */
export const KAFKA_HOST_EXTERNAL_PORT = 43218;

export const Ingest = Stackit.Intake.Runner("IntakeKafkaRunner", CAPACITY);

export const Events = Ingest.pipe(
  Effect.flatMap((runner) =>
    Stackit.Intake.Intake("IntakeKafkaIntake", { runnerId: runner.runnerId, catalog: CATALOG }),
  ),
);

export const Producer = Events.pipe(
  Effect.flatMap((pipeline) =>
    Stackit.Intake.User("IntakeKafkaProducer", { intakeId: pipeline.intakeId, password: PASSWORD }),
  ),
);

export const DeadLetters = Events.pipe(
  Effect.flatMap((pipeline) =>
    Stackit.Intake.User("IntakeKafkaDeadLetters", {
      intakeId: pipeline.intakeId,
      type: "dead-letter",
      password: PASSWORD,
    }),
  ),
);

/**
 * A long-lived host with the Kafka bindings: `kafkajs` needs TCP sockets, which a Worker
 * isn't known to give it. `/produce` publishes the `value` parameter, and `/dead-letters`
 * runs `ConsumeDeadLetter` for a bounded time and reports what it took.
 */
export default class IntakeKafkaHost extends Docker.Service<IntakeKafkaHost>()(
  "StackitIntakeKafkaHost",
  {
    main: import.meta.filename,
    port: 3000,
    ports: [{ external: KAFKA_HOST_EXTERNAL_PORT, internal: 3000 }],
    replicas: 1,
  },
  Effect.gen(function* () {
    const pipeline = yield* Events;
    const producer = yield* Producer;
    const reader = yield* DeadLetters;
    const produce = yield* Stackit.Intake.Produce(pipeline, producer);
    const consume = yield* Stackit.Intake.ConsumeDeadLetter(pipeline, reader);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://service");
        switch (url.pathname) {
          case "/produce": {
            const outcome = yield* produce({
              messages: [{ value: url.searchParams.get("value") ?? "" }],
            }).pipe(Effect.exit);
            return yield* HttpServerResponse.json(
              outcome._tag === "Success"
                ? { ok: true, records: outcome.value }
                : { ok: false, error: Cause.pretty(outcome.cause) },
            );
          }
          case "/dead-letters": {
            const taken: Array<{ text: string; headers: Readonly<Record<string, string>> }> = [];
            const outcome = yield* consume({
              groupId: "alchemy-test",
              handler: (message) =>
                Effect.sync(() => {
                  taken.push({ text: message.text, headers: message.headers });
                }),
            }).pipe(Effect.timeoutOption("20 seconds"), Effect.exit);
            return yield* HttpServerResponse.json({
              taken,
              error: outcome._tag === "Failure" ? Cause.pretty(outcome.cause) : undefined,
            });
          }
          case "/dead-letters-skip": {
            const taken: string[] = [];
            const outcome = yield* consume({
              groupId: "alchemy-test-skip",
              onFailure: "skip",
              // A defect, as `Effect.orDie` makes of a typed failure in a handler.
              handler: (message) =>
                Effect.sync(() => {
                  taken.push(message.text);
                }).pipe(Effect.andThen(Effect.die("alchemy test: this handler dies"))),
            }).pipe(Effect.timeoutOption("20 seconds"), Effect.exit);
            return yield* HttpServerResponse.json({
              taken,
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
      Layer.mergeAll(Stackit.Intake.ProduceKafka, Stackit.Intake.ConsumeDeadLetterKafka),
    ),
  ),
) {}
