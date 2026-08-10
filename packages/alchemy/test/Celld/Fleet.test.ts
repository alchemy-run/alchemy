import * as AWS from "@/AWS";
import * as Celld from "@/Celld";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Api from "./fixtures/api.ts";
import { Cells } from "./fixtures/cells.ts";
import FleetLive from "./fixtures/fleet.ts";
import { CellsWorker } from "./fixtures/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Celld.providers()),
  // Same escape as the conformance suites: point at a virgin stage to
  // iterate while a leaked generation (failed destroy, lost state) awaits
  // `bun nuke` — redeploying the default stage collides with it via tag
  // recovery.
  stage: process.env.CELLD_FLEET_STAGE,
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CelldFleet");

let baseUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

// Cold path: Lambda init + fleet node startup + celld deployment pickup.
// Fargate placement + the service rollout after the first `celld deploy`
// can take a couple of minutes — budget generously, poll boundedly.
const readinessPolicy = Schedule.max([
  Schedule.fixed("5 seconds"),
  Schedule.recurs(60),
]);

const send = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e): boolean => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("1 second"),
        Schedule.recurs(6),
      ]),
    }),
  );

const json = (url: string) =>
  send(url).pipe(Effect.flatMap((response) => response.json));

// Full live e2e: S3 bucket + VPC + Cloud Map + Fargate celld nodes +
// `celld deploy` + a VPC-attached Lambda driving cells over the fleet
// gateway. First deploy builds/pushes the node image and waits out Fargate
// placement — keep it out of the FAST sweep.
describe.skipIf(!!process.env.FAST)("Celld Fleet (live)", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo("Celld fleet: destroying previous resources");
      yield* sharedStack.destroy();

      yield* Effect.logInfo("Celld fleet: deploying fixture stack");
      const { apiUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          yield* Cells;
          yield* CellsWorker;
          const api = yield* Api;
          return { apiUrl: api.functionUrl };
        }).pipe(Effect.provide(FleetLive)),
      );

      expect(apiUrl).toBeTruthy();
      baseUrl = String(apiUrl).replace(/\/+$/, "");

      yield* Effect.logInfo(`Celld fleet: probing readiness at ${baseUrl}`);
      yield* HttpClient.get(`${baseUrl}/counter/readiness/get`).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? Effect.succeed(response)
            : Effect.fail(new Error(`fleet not ready: ${response.status}`)),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      yield* Effect.logInfo("Celld fleet: ready");
    }),
    { timeout: 900_000 },
  );

  // Destroy must ride out Lambda hyperplane ENI teardown (5-20 min before
  // the VPC's subnets/SGs release).
  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 1_800_000,
  });

  test(
    "increment persists across calls to the same cell",
    Effect.gen(function* () {
      const first = (yield* json(`${baseUrl}/counter/room-a/increment`)) as {
        value: number;
      };
      const second = (yield* json(`${baseUrl}/counter/room-a/increment`)) as {
        value: number;
      };
      expect(second.value).toBe(first.value + 1);
      const read = (yield* json(`${baseUrl}/counter/room-a/get`)) as {
        value: number;
      };
      expect(read.value).toBe(second.value);
    }),
    { timeout: 120_000 },
  );

  test(
    "cells are isolated by name",
    Effect.gen(function* () {
      yield* json(`${baseUrl}/counter/room-b/increment`);
      const b = (yield* json(`${baseUrl}/counter/room-b/get`)) as {
        value: number;
      };
      const fresh = (yield* json(`${baseUrl}/counter/never-touched/get`)) as {
        value: number;
      };
      expect(b.value).toBeGreaterThan(0);
      expect(fresh.value).toBe(0);
    }),
    { timeout: 120_000 },
  );

  test(
    "streaming methods round-trip through the gateway",
    Effect.gen(function* () {
      const result = (yield* json(`${baseUrl}/counter/room-a/tick?n=5`)) as {
        values: number[];
      };
      expect(result.values).toEqual([1, 2, 3, 4, 5]);
    }),
    { timeout: 120_000 },
  );

  test(
    "the fleet's own worker serves HTTP with native cell access",
    Effect.gen(function* () {
      const first = (yield* json(`${baseUrl}/counter/_/worker`)) as {
        from: string;
        value: number;
      };
      expect(first.from).toBe("fleet-worker");
      expect(first.value).toBeGreaterThan(0);
      const second = (yield* json(`${baseUrl}/counter/_/worker`)) as {
        value: number;
      };
      expect(second.value).toBe(first.value + 1);
    }),
    { timeout: 120_000 },
  );

  test(
    "typed errors decode across the wire",
    Effect.gen(function* () {
      const result = (yield* json(`${baseUrl}/counter/room-a/fail`)) as {
        tag: string;
      };
      expect(result.tag).toBe("CounterBoom");
    }),
    { timeout: 120_000 },
  );
});
