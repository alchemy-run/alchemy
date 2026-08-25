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
