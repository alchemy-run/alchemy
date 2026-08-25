import * as AWS from "@/AWS";
import * as Rivet from "@/Rivet";
import {
  makeRivetActorClient,
  RIVET_ACTOR_NAMESPACE,
  RIVET_RUNNER_POOL,
} from "@/Rivet/Gateway.ts";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { IngressActors, IngressWorker } from "./ingress/cluster.ts";
import IngressWorkerLive from "./ingress/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Rivet.providers()),
  stage: process.env.RIVET_CONFORMANCE_STAGE,
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "RivetIngress");

let gatewayUrl = "";
let adminToken = "";

// Public ingress for the Rivet Engine's guard gateway: an internet-facing
// ALB in front of the guard port (target group attached to the EXISTING
// engine service, health-checked on the api-peer's /health). The worker's
// url attribute becomes the ALB URL, and the test drives the actor gateway
// protocol through it DIRECTLY — no Lambda indirection. First deploy pulls
// the engine image, builds the runner image, and waits out Fargate
// placement + target health — keep it out of FAST.
describe.skipIf(!!process.env.FAST)("rivet ingress (public ALB)", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      const { url, token } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          yield* IngressActors;
          const worker = yield* IngressWorker;
          return { url: worker.url, token: worker.adminToken };
        }).pipe(Effect.provide(IngressWorkerLive)),
      );
      expect(url).toBeTruthy();
      gatewayUrl = String(url).replace(/\/+$/, "");
      adminToken = Redacted.isRedacted(token)
        ? String(Redacted.value(token as Redacted.Redacted<string>))
        : String(token);
      yield* Effect.logInfo(`rivet ingress gateway: ${gatewayUrl}`);
      expect(gatewayUrl).toMatch(/^http:\/\//);
    }),
    { timeout: 1_500_000 },
  );

  afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
    timeout: 1_800_000,
  });

  test(
    "the actor gateway serves through the public ALB",
    Effect.gen(function* () {
      const counters = makeRivetActorClient(
        {
          endpoint: gatewayUrl,
          token: adminToken,
          namespace: RIVET_ACTOR_NAMESPACE,
          pool: RIVET_RUNNER_POOL,
        },
        "Counter",
      );
      const counter = counters.getByName("ingress-probe");
      // Retry through the cold actor's first placement (runner registration
      // can lag the ALB's first 200s by a few seconds).
      const first = (yield* (
        counter.increment() as Effect.Effect<number, unknown>
      ).pipe(
        Effect.retry({
          schedule: Schedule.spaced("5 seconds"),
          times: 24,
        }),
      )) as number;
      const second = (yield* counter.increment() as Effect.Effect<
        number,
        unknown
      >) as number;
      expect(second).toBe(first + 1);
      const read = (yield* counter.get() as Effect.Effect<
        number,
        unknown
      >) as number;
      expect(read).toBe(second);
    }),
    { timeout: 300_000 },
  );
});
