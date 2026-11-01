import * as Docker from "@alchemy.run/docker";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as management from "@distilled.cloud/stackit/rabbitmq_management";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ensureDockerSwarm } from "../../Docker/Runtime.ts";
import { stackitTags } from "../helpers.ts";
import RabbitMQConsumer, {
  AppCredential,
  CONSUMER_EXTERNAL_PORT,
  DRAIN_QUEUE,
  EVENT_QUEUE,
} from "./fixtures/consumer.ts";
import { onBroker, slow } from "./rabbitmq.ts";

const providers = Layer.mergeAll(Stackit.providers(), Docker.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitRabbitMQConsumerStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* RabbitMQConsumer;
    const credential = yield* AppCredential;
    return {
      httpApiUri: credential.httpApiUri,
      username: credential.username,
      password: credential.password,
    };
  }),
);

const CONSUMER_URL = `http://127.0.0.1:${CONSUMER_EXTERNAL_PORT}`;

const options = { timeout: 300_000 } as const;

const publish = (queue: string, payload: string) =>
  management.publishMessage({
    vhost: "/",
    exchange: "amq.default",
    routing_key: queue,
    payload,
    payload_encoding: "string",
    properties: {},
  });

const getJson = (route: string) =>
  HttpClient.get(`${CONSUMER_URL}${route}`).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
  );

// The instance is billed per started hour: gated behind STACKIT_TEST_SLOW, like the
// suites of the same resources. The host runs on the local Docker swarm.
describe.sequential.skipIf(slow)(
  "STACKIT RabbitMQ AMQP bindings on a Docker service",
  { tags: [...stackitTags("rabbitmq", "bindings"), "provider:docker"] },
  () => {
    const stack = beforeAll(ensureDockerSwarm.pipe(Effect.orDie, Effect.andThen(deploy(Stack))), {
      timeout: 2_700_000,
    });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 2_700_000 });

    describe("QueueEventSource", () => {
      test.provider(
        "hands a published message to the host's background consumer",
        (_stack) =>
          Effect.gen(function* () {
            const access = yield* stack;
            yield* onBroker(
              access,
              management.putQueue({ vhost: "/", queue: EVENT_QUEUE, durable: true }),
            );
            const sent = yield* onBroker(access, publish(EVENT_QUEUE, "to the event source"));
            expect(sent.routed).toEqual(true);

            // The consumer may have started before the queue existed: it reconnects.
            const body = yield* getJson("/received").pipe(
              Effect.map((response) => response as { received: string[] }),
              Effect.repeat({
                schedule: Schedule.spaced("5 seconds"),
                until: (response) => response.received.includes("to the event source"),
                times: 36,
              }),
            );
            expect(body.received).toContain("to the event source");

            // Out of band: the message was acknowledged, not left on the queue.
            const left = yield* onBroker(
              access,
              management.getMessages({
                vhost: "/",
                queue: EVENT_QUEUE,
                count: 1,
                ackmode: "ack_requeue_true",
                encoding: "auto",
              }),
            );
            expect(left).toEqual([]);
          }),
        options,
      );
    });

    describe("Consume", () => {
      test.provider(
        "drains a queue for as long as the caller lets it run",
        (_stack) =>
          Effect.gen(function* () {
            const access = yield* stack;
            yield* onBroker(
              access,
              management.putQueue({ vhost: "/", queue: DRAIN_QUEUE, durable: true }),
            );
            yield* onBroker(access, publish(DRAIN_QUEUE, "first"));
            yield* onBroker(access, publish(DRAIN_QUEUE, "second"));

            const body = (yield* getJson("/consume")) as {
              drained: string[];
              error?: string;
            };
            expect(body.error).toBeUndefined();
            expect([...body.drained].sort()).toEqual(["first", "second"]);

            const left = yield* onBroker(
              access,
              management.getMessages({
                vhost: "/",
                queue: DRAIN_QUEUE,
                count: 1,
                ackmode: "ack_requeue_true",
                encoding: "auto",
              }),
            );
            expect(left).toEqual([]);
          }),
        options,
      );
    });
  },
);
