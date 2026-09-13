import * as AWS from "@/AWS";
import * as Rivet from "@/Rivet";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  conformanceTests,
  waitForReady,
} from "../Cloudflare/Workers/conformance/spec.ts";
import ConformanceApi from "./fixtures/api.ts";
import { ConformanceActors, ConformanceWorker } from "./fixtures/cluster.ts";
import ConformanceWorkerLive from "./fixtures/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Rivet.providers(), Rivet.Ecs()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` below really drains
// whatever a previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(
  testOptions,
  "RivetConformance",
  import.meta.url,
);

let baseUrl = "";

/** GET a Lambda route and decode its JSON body (200 only). */
const getJson = <T>(path: string) =>
  HttpClient.get(`${baseUrl}${path}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? response.json
        : Effect.fail(new Error(`${path} answered ${response.status}`)),
    ),
    Effect.map((value) => value as T),
  );

// The engine conformance spec, run against a REAL Rivet Engine on Fargate.
//
// Rivet workers have NO HTTP surface: the deploy module becomes a RUNNER
// container with no inbound ports and its impl returns `{}` — the Durable
// Objects are reachable ONLY through `Rivet.bindWorker`'s stub over the
// engine's gateway. So there is no in-worker lane here (unlike celld); the
// fronting Lambda re-exposes the conformance routes and every test drives
// the actors through the stub. Gated like an entitlement: set
// ALCHEMY_TEST_FLEETS=1 to run it (first deploy builds the runner image
// and waits out Fargate placement — minutes, not seconds).
describe.skipIf(!process.env.ALCHEMY_TEST_FLEETS || !!process.env.FAST)(
  "rivet engine conformance",
  () => {
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
      // Runner image build + ECR push + Fargate placement of engine and
      // runner + the Lambda's VPC attachment.
      { timeout: 900_000 },
    );

    // Destroy must ride out Lambda hyperplane ENI teardown (5-20 min before
    // the VPC's subnets/SGs release).
    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
      timeout: 1_800_000,
    });

    conformanceTests(test, { baseUrl: () => baseUrl });

    // ── build-once: one instance build per actor instance ─────────────────
    //
    // rivetkit mints a fresh per-call context for every action and disposes
    // it afterwards, so the bridge keys the built Durable Object on the
    // actor's own lifecycle (`createVars`), not on that context. Six actions
    // against one instance must leave its init count at exactly 1.
    test(
      "build-once: the instance init runs once across N actions",
      Effect.gen(function* () {
        const result = yield* getJson<{ inits: number }>(
          "/probe-inits/once?n=5",
        );
        expect(result.inits).toBe(1);
      }),
      { timeout: 120_000 },
    );

    // ── binding security: the cluster's caller boundary ───────────────────
    //
    // PINNED PLATFORM BEHAVIOR: the Rivet Engine's *data-plane* gateway
    // (`/gateway/{actor}/action/{m}`) does NOT enforce `rvt-token` — the
    // admin token guards the management APIs (`/runner-configs`, …), not
    // actor calls. Rivet's caller-security boundary is NETWORK isolation:
    // the engine serves on a private VPC and `Rivet.bindWorker` is what
    // attaches a caller to it (subnets + security groups) — it binds no
    // token, and `expose`/`domain` are refused. These probes pin that
    // behavior so a future engine release that starts enforcing tokens on
    // the data plane fails loudly here instead of silently changing the
    // security model.
    const probe = (kind: string) =>
      getJson<{ status: number; body: string }>(`/probe-unauth/${kind}`);

    test(
      "security: the gateway data plane is network-guarded, not token-guarded (pinned)",
      Effect.gen(function* () {
        const missing = yield* probe("missing");
        const wrong = yield* probe("wrong");
        // Both served from inside the VPC — the engine does not reject on
        // the token. If this pin breaks, the engine started enforcing
        // tokens: flip these to 4xx assertions and give `bindWorker` a
        // token to bind (and the stub an `rvt-token` to send).
        expect(missing.status).toBe(200);
        expect(wrong.status).toBe(200);
      }),
      { timeout: 120_000 },
    );
  },
);
