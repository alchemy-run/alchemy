import * as Docker from "@alchemy.run/docker";
import * as Stackit from "@alchemy.run/stackit";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { ensureDockerSwarm } from "../../Docker/Runtime.ts";
import { stackitTags } from "../helpers.ts";
import PubSubConsumer, { CONSUMER_EXTERNAL_PORT, FAIL_ONCE } from "./fixtures/consumer.ts";

const providers = Layer.mergeAll(Stackit.providers(), Docker.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "StackitPubSubConsumerStack",
  { providers, state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* PubSubConsumer;
    return {};
  }),
);

const CONSUMER_URL = `http://127.0.0.1:${CONSUMER_EXTERNAL_PORT}`;

const options = { timeout: 300_000 } as const;

interface Received {
  readonly received: ReadonlyArray<{ readonly text: string; readonly deliveryAttempts: number }>;
}

const getJson = (route: string) =>
  HttpClient.get(`${CONSUMER_URL}${route}`).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((response) => response.json),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
  );

/** Publish through the host until the grant has propagated. */
const publish = (text: string) =>
  getJson(`/publish?text=${encodeURIComponent(text)}`).pipe(
    Effect.map((body) => body as { ok: boolean; error?: string }),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (body) => body.ok,
      times: 24,
    }),
  );

const receivedUntil = (until: (body: Received) => boolean) =>
  getJson("/received").pipe(
    Effect.map((body) => body as unknown as Received),
    Effect.repeat({ schedule: Schedule.spaced("5 seconds"), until, times: 36 }),
  );

describe.sequential(
  "STACKIT Pub/Sub event source on a Docker service",
  { tags: [...stackitTags("pubsub", "eventsource"), "provider:docker"] },
  () => {
    beforeAll(ensureDockerSwarm.pipe(Effect.orDie, Effect.andThen(deploy(Stack))), {
      timeout: 600_000,
    });
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), { timeout: 600_000 });

    describe("SubscriptionEventSource", () => {
      test.provider(
        "hands a published message to the host's background loop, once",
        (_stack) =>
          Effect.gen(function* () {
            const sent = yield* publish("to the event source");
            expect(sent).toEqual({ ok: true });

            const body = yield* receivedUntil((current) =>
              current.received.some((message) => message.text === "to the event source"),
            );
            const first = body.received.filter((message) => message.text === "to the event source");
            expect(first[0]?.deliveryAttempts).toEqual(1);

            // The loop acknowledged it, so it doesn't come back past the 30 second deadline.
            yield* Effect.sleep("45 seconds");
            const later = (yield* getJson("/received")) as unknown as Received;
            expect(
              later.received.filter((message) => message.text === "to the event source").length,
            ).toEqual(first.length);
          }),
        options,
      );

      test.provider(
        "delivers a message again after its handler fails",
        (_stack) =>
          Effect.gen(function* () {
            yield* publish(FAIL_ONCE);
            const body = yield* receivedUntil((current) =>
              current.received.some(
                (message) => message.text === FAIL_ONCE && message.deliveryAttempts >= 2,
              ),
            );
            expect(
              body.received.filter((message) => message.text === FAIL_ONCE).length,
            ).toBeGreaterThanOrEqual(2);
          }),
        options,
      );
    });
  },
);
