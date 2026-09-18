import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import OtelEventFlushWorker from "./fixtures/otel-event-flush-worker.ts";
import { startOtlpCollector } from "../Utils/OtlpCollector.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "delivers Worker and Durable Object OTLP batches without delaying the Worker response",
  (stack) =>
    Effect.gen(function* () {
      // Hold only Worker exports: the DO may flush in either foreground or background.
      const collector = yield* startOtlpCollector({
        holdResponse: (body) =>
          body.includes('"name":"otel-event-flush.worker"'),
      });
      const currentConfig = yield* ConfigProvider.ConfigProvider;
      yield* stack.destroy();
      const deployment = yield* stack
        .deploy(
          Effect.gen(function* () {
            const worker = yield* OtelEventFlushWorker;
            return { url: worker.url };
          }),
        )
        .pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.orElse(
              ConfigProvider.fromUnknown({
                OTLP_EVENT_FLUSH_URL: `${collector.url}/v1/traces`,
              }),
              currentConfig,
            ),
          ),
        );

      if (deployment.url === undefined) {
        return yield* Effect.die(
          "OTLP event flush test Worker URL unavailable",
        );
      }
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(deployment.url);
      expect(response.status).toBe(200);
      expect(yield* response.text).toBe("worker-saw:durable-object-ok");

      // Release only after the response, not on a timer that can outlive
      // the exporter's three-second shutdown deadline under runner load.
      expect(collector.completedRequests.value).toBeLessThanOrEqual(1);
      yield* Effect.sync(collector.releaseResponses);

      // Both batches must be acknowledged before the next event.
      yield* Effect.sync(() => collector.completedRequests.value).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (completed) => completed >= 2,
          times: 30,
        }),
      );
      expect(collector.completedRequests.value).toBe(2);

      // Same contract for the Durable Object RPC event path: the Worker's
      // own batch (the 4th) must not be complete at response time.
      yield* Effect.sync(collector.holdResponses);
      const rpcResponse = yield* client.get(`${deployment.url}/rpc`);
      expect(rpcResponse.status).toBe(200);
      expect(yield* rpcResponse.text).toBe("worker-saw:durable-object-rpc-ok");
      expect(collector.completedRequests.value).toBeLessThanOrEqual(3);
      yield* Effect.sync(collector.releaseResponses);

      yield* Effect.sync(() => collector.completedRequests.value).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("100 millis"),
          until: (completed) => completed >= 4,
          times: 30,
        }),
      );
      expect(collector.completedRequests.value).toBe(4);
      expect(collector.requests).toHaveLength(4);
      expect(
        collector.requests.every((batch) => batch.completed && !batch.aborted),
      ).toBe(true);
      for (const [name, count] of [
        ["otel-event-flush.worker", 2],
        ["otel-event-flush.child", 1],
        ["otel-event-flush.rpc", 1],
        ["http.server GET", 3],
      ] as const) {
        expect(
          collector.requests.filter((batch) =>
            batch.body.includes(`"name":"${name}"`),
          ),
        ).toHaveLength(count);
      }

      yield* stack.destroy();
      expect(collector.completedRequests.value).toBe(4);
    }),
  { timeout: 120_000 },
);
