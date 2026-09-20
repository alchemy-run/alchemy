import * as machines from "@distilled.cloud/fly-io/machines";
import { waitHealthy } from "@/Fly/replicas";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { assertAppGone, census, deployWorker } from "./fixtures/bluegreen.ts";
import { throughProxy, transportProxy } from "./fixtures/transport.ts";

let endpoint: string | undefined;
const { test } = Test.make({ providers: throughProxy(() => endpoint) });

test.provider(
  "S07 health polling recovers a lost real GET and exhausts a persistent connection cut",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* deployWorker(stack, "one", {
        deploy: { strategy: "bluegreen", healthTimeout: "30 seconds" },
      });
      const observed = yield* machines.getMachine({
        app_name: initial.appName,
        machine_id: initial.machineId,
      });
      const proxy = yield* transportProxy();
      const match = (event: { method: string; path: string }) =>
        event.method === "GET" &&
        event.path.endsWith(`/machines/${initial.machineId}`);
      yield* Effect.sync(() => {
        endpoint = proxy.url;
        proxy.arm({ match, action: "drop-response", remaining: 1 });
      });
      try {
        const healthy = yield* waitHealthy(
          initial.appName,
          observed,
          30_000,
          observed.config!,
        );
        expect(healthy.id).toBe(initial.machineId);
        expect(healthy.instance_id).toBe(observed.instance_id);
        expect(
          healthy.checks?.every((check) => check.status === "passing"),
        ).toBe(true);
        expect(
          proxy.events.filter(
            (event) => event.stage === "dropped" && event.status === 200,
          ),
        ).toHaveLength(1);
        yield* Effect.sync(() =>
          proxy.arm({ match, action: "cut-request", remaining: Infinity }),
        );
        let attempts = 0;
        const client = yield* HttpClient.HttpClient;
        const observedClient = HttpClient.tapRequest(client, (request) =>
          Effect.sync(() => {
            if (
              request.method === "GET" &&
              request.url.endsWith(`/machines/${initial.machineId}`)
            ) {
              attempts++;
            }
          }),
        );
        const started = yield* Clock.currentTimeMillis;
        const failed = yield* waitHealthy(
          initial.appName,
          healthy,
          8_000,
          healthy.config!,
        ).pipe(
          Effect.provideService(HttpClient.HttpClient, observedClient),
          Effect.result,
        );
        expect((yield* Clock.currentTimeMillis) - started).toBeLessThanOrEqual(
          12_000,
        );
        expect(Result.isFailure(failed)).toBe(true);
        if (Result.isFailure(failed)) {
          expect(failed.failure).toMatchObject({
            _tag: "Fly.ReplicaChecksNotPassing",
            appName: initial.appName,
            machineId: initial.machineId,
          });
        }
        expect(
          proxy.events.filter((event) => event.stage === "cut").length,
        ).toBeGreaterThan(0);
        // Count logical client calls independently of Bun's physical GET retries.
        expect(attempts).toBeGreaterThan(0);
        expect(attempts).toBeLessThanOrEqual(11);
        const live = yield* census(initial.appName);
        expect(live.map((machine) => machine.id)).toEqual(initial.machineIds);
        expect(live[0]!.cordoned).toBe(false);
      } finally {
        yield* Effect.sync(() => {
          endpoint = undefined;
          proxy.clear();
        });
      }
      yield* stack.destroy();
      yield* assertAppGone(initial.appName);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          endpoint = undefined;
        }),
      ),
    ),
  { timeout: 180_000 },
);
