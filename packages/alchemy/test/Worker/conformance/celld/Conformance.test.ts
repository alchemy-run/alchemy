import * as AWS from "@/AWS";
import * as Celld from "@/Celld";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { conformanceTests, waitForReady } from "../spec.ts";
import ConformanceApi from "./api.ts";
import { ConformanceCells, ConformanceWorker } from "./fleet.ts";
import ConformanceWorkerLive from "./worker.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Celld.providers()),
  // Same escape as the Rivet suite: point at a virgin stage to iterate
  // while a leaked generation (failed destroy, lost state) awaits
  // `bun nuke` — redeploying the default stage collides with it via tag
  // recovery.
  stage: process.env.CELLD_CONFORMANCE_STAGE,
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "CelldConformance");

let baseUrl = "";

// The engine conformance spec, run against a REAL celld fleet on Fargate.
// The fleet is private, so the Lambda re-exposes the same routes and
// drives the cells through `Celld.bindWorker`'s stub. First deploy builds
// the node image and waits out Fargate placement — keep it out of FAST.
describe.skipIf(!!process.env.FAST)("celld engine conformance", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const { apiUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          yield* ConformanceCells;
          yield* ConformanceWorker;
          const api = yield* ConformanceApi;
          return { apiUrl: api.functionUrl };
        }).pipe(Effect.provide(ConformanceWorkerLive)),
      );
      expect(apiUrl).toBeTruthy();
      baseUrl = String(apiUrl).replace(/\/+$/, "");
      yield* Effect.logInfo(`celld conformance api: ${baseUrl}`);
      // Fargate placement + the service rollout after the first `celld
      // deploy` take minutes on a cold fleet.
      yield* waitForReady(baseUrl, { attempts: 60, base: "5 seconds" });
    }),
    { timeout: 900_000 },
  );

  // Destroy must ride out Lambda hyperplane ENI teardown (5-20 min before
  // the VPC's subnets/SGs release).
  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 1_800_000,
  });

  conformanceTests(test as any, {
    baseUrl: () => baseUrl,
    capabilities: { sql: true, alarms: true },
  });

  // ── any-node forwarding: cell affinity under DNS round-robin ──────────
  //
  // The fleet runs THREE nodes behind one round-robin Cloud Map name, and
  // the Lambda's `/affinity` route performs sequential increments on ONE
  // cell over a FRESH connection each (`connection: close`), so requests
  // land on arbitrary nodes. celld's design claim is that any node
  // forwards a cell's request to its single lease owner — if that holds,
  // the returned values are strictly consecutive with no resets or
  // duplicates; a second cell instance on another node would fork the
  // counter and break the sequence.
  test(
    "affinity: sequential increments on one cell stay strictly consecutive across a 3-node fleet",
    Effect.gen(function* () {
      const collect = (n: number) =>
        HttpClient.get(`${baseUrl}/affinity/affinity-probe?n=${n}`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? response.json
              : Effect.fail(
                  new Error(`affinity route answered ${response.status}`),
                ),
          ),
          Effect.map((value) => (value as { values: number[] }).values),
        );
      // Two batches (two Lambda invocations) with a pause longer than the
      // Cloud Map record TTL between them, so the second batch re-resolves
      // and has every chance of starting on a different node.
      const first = yield* collect(10);
      yield* Effect.sleep("12 seconds");
      const second = yield* collect(10);
      const values = [...first, ...second];
      expect(values).toHaveLength(20);
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBe(values[i - 1] + 1);
      }
    }),
    { timeout: 180_000 },
  );

  // ── binding security: the gateway's RPC guard ─────────────────────────
  const probe = (kind: string) =>
    HttpClient.get(`${baseUrl}/probe-unauth/${kind}`).pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? response.json
          : Effect.fail(new Error(`probe route answered ${response.status}`)),
      ),
      Effect.map((value) => value as { status: number; body: string }),
    );

  test(
    "security: an RPC path without the secret header answers 401",
    Effect.gen(function* () {
      const missing = yield* probe("missing");
      expect(missing.status).toBe(401);
    }),
    { timeout: 120_000 },
  );

  test(
    "security: a wrong secret answers 401 with an identical body",
    Effect.gen(function* () {
      const missing = yield* probe("missing");
      const wrong = yield* probe("wrong");
      expect(wrong.status).toBe(401);
      expect(wrong.body).toBe(missing.body);
    }),
    { timeout: 120_000 },
  );

  test(
    "security: the public fetch surface serves without any header",
    Effect.gen(function* () {
      const open = yield* probe("public");
      expect(open.status).toBe(200);
      expect(JSON.parse(open.body)).toEqual({ value: 0 });
    }),
    { timeout: 120_000 },
  );
});
