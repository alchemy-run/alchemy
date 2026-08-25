import * as AWS from "@/AWS";
import * as Rivet from "@/Rivet";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { conformanceTests, waitForReady } from "../spec.ts";
import ConformanceApi from "./api.ts";
import { ConformanceActors, ConformanceWorker } from "./cluster.ts";
import ConformanceWorkerLive from "./worker.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Rivet.providers()),
  // The scratch state is in-memory, so a run in a fresh process cannot
  // destroy a previous process's NO_DESTROY-kept deployment — and several
  // physical names carry a per-instance suffix minted into that lost state,
  // so redeploying the same stage collides with the leaked generation via
  // tag recovery (e.g. the old IGW gets dragged toward the new VPC). Point
  // this at a virgin stage to iterate while a leaked generation awaits
  // `bun nuke`.
  stage: process.env.RIVET_CONFORMANCE_STAGE,
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RivetConformance");

let baseUrl = "";

// The engine conformance spec, run against a REAL Rivet Engine on
// Fargate. The engine is private, so the Lambda re-exposes the same routes
// and drives the actors through `Rivet.bindWorker`'s stub. First deploy
// builds the runner image and waits out Fargate placement — keep it out of
// FAST.
describe.skipIf(!!process.env.FAST)("rivet engine conformance", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const { apiUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          yield* ConformanceActors;
          yield* ConformanceWorker;
          const api = yield* ConformanceApi;
          return { apiUrl: api.functionUrl };
        }).pipe(Effect.provide(ConformanceWorkerLive)),
      );
      expect(apiUrl).toBeTruthy();
      baseUrl = String(apiUrl).replace(/\/+$/, "");
      yield* Effect.logInfo(`rivet conformance api: ${baseUrl}`);
      // Fargate placement for engine + runner, then the runner's tunnel
      // registration, take minutes on a cold cluster.
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

  // ── binding security: the engine gateway's token guard ────────────────
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
    "security: a gateway call without the engine token is rejected",
    Effect.gen(function* () {
      const missing = yield* probe("missing");
      expect(missing.status).toBeGreaterThanOrEqual(400);
    }),
    { timeout: 120_000 },
  );

  test(
    "security: a wrong engine token is rejected",
    Effect.gen(function* () {
      const wrong = yield* probe("wrong");
      expect(wrong.status).toBeGreaterThanOrEqual(400);
    }),
    { timeout: 120_000 },
  );
});
