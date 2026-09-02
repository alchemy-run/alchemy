import * as AWS from "@/AWS";
import * as Celld from "@/Celld";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  conformanceTests,
  waitForReady,
} from "../Cloudflare/Workers/conformance/spec.ts";
import ConformanceApi from "./fixtures/api.ts";
import { ConformanceCells, ConformanceWorker } from "./fixtures/fleet.ts";
import ConformanceWorkerLive from "./fixtures/worker.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.Ecs()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
// File-backed scratch state: the leading `destroy()` below really drains
// whatever a previous (interrupted or NO_DESTROY) run left behind.
const sharedStack = Core.scratchStack(
  testOptions,
  "CelldConformance",
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

/**
 * GET a conformance route THROUGH the fleet worker's own `fetch` (the
 * Lambda's `/worker/http/<route>` forwards it over the stub's raw fetch),
 * and decode the JSON the worker answered with.
 */
const inWorker = <T>(route: string) =>
  getJson<{ from: string; status: number; body: string }>(
    `/worker/http${route}`,
  ).pipe(
    Effect.flatMap((forwarded) => {
      expect(forwarded.from).toBe("fleet-worker");
      return forwarded.status === 200
        ? Effect.try({
            try: () => JSON.parse(forwarded.body) as T,
            catch: (cause) =>
              new Error(
                `${route}: non-JSON body ${forwarded.body}: ${String(cause)}`,
              ),
          })
        : Effect.fail(
            new Error(
              `${route} answered ${forwarded.status} in-worker: ${forwarded.body}`,
            ),
          );
    }),
  );

// The engine conformance spec, run against a REAL celld fleet on Fargate.
// The fleet is private, so the Lambda re-exposes the same routes and
// drives the cells through `Celld.bindWorker`'s stub. Gated like an
// entitlement: set ALCHEMY_TEST_FLEETS=1 to run it (first deploy builds
// the node image and waits out Fargate placement — minutes, not seconds).
describe.skipIf(!process.env.ALCHEMY_TEST_FLEETS || !!process.env.FAST)(
  "celld engine conformance",
  () => {
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
      // Image build + ECR push + Fargate placement of a 3-node fleet + the
      // Lambda's VPC attachment.
      { timeout: 900_000 },
    );

    // Destroy must ride out Lambda hyperplane ENI teardown (5-20 min before
    // the VPC's subnets/SGs release).
    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
      timeout: 1_800_000,
    });

    // ── the full spec, through the Lambda's remote stub ───────────────────
    conformanceTests(test, { baseUrl: () => baseUrl });

    // ── the full surface again, IN-WORKER (native cell access) ────────────
    //
    // The spec above reaches the cells through `Celld.bindWorker`'s stub.
    // These drive the fleet worker's OWN `fetch` (the same conformance
    // routes over a native `yield* Counter` namespace), so KV, SQL, alarms,
    // streams and typed errors are proven on the node itself, not only
    // over the gateway. Cells are `w-` prefixed so the two paths never
    // share state.
    test(
      "in-worker: kv writes persist via the worker's own fetch surface",
      Effect.gen(function* () {
        const first = yield* inWorker<{ value: number }>("/kv/w-a/increment");
        expect(first.value).toBeGreaterThan(0);
        const second = yield* inWorker<{ value: number }>("/kv/w-a/increment");
        expect(second.value).toBe(first.value + 1);
        const read = yield* inWorker<{ value: number }>("/kv/w-a/get");
        expect(read.value).toBe(second.value);
      }),
      { timeout: 120_000 },
    );

    test(
      "in-worker: sql exec with bindings, then read back",
      Effect.gen(function* () {
        yield* inWorker("/sql/w-s1/clear");
        yield* inWorker("/sql/w-s1/insert?v=hello");
        yield* inWorker("/sql/w-s1/insert?v=world");
        const rows = yield* inWorker<{ rows: { v: string }[] }>(
          "/sql/w-s1/all",
        );
        expect(rows.rows.map((r) => r.v).sort()).toEqual(["hello", "world"]);
      }),
      { timeout: 120_000 },
    );

    test(
      "in-worker: setAlarm fires the alarm handler and clears",
      Effect.gen(function* () {
        yield* inWorker("/alarm/w-t1/arm?ms=1500");
        const armed = yield* inWorker<{ time: number | null }>(
          "/alarm/w-t1/peek",
        );
        expect(armed.time).not.toBeNull();
        const fired = yield* inWorker<{ count: number }>(
          "/alarm/w-t1/fired",
        ).pipe(
          Effect.map((r) => r.count),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (count) => count > 0,
            times: 20,
          }),
        );
        expect(fired).toBeGreaterThan(0);
        const cleared = yield* inWorker<{ time: number | null }>(
          "/alarm/w-t1/peek",
        );
        expect(cleared.time).toBeNull();
      }),
      // ~1.5s alarm + a bounded 20 × 1s poll, each hop through the Lambda.
      { timeout: 180_000 },
    );

    test(
      "in-worker: a Stream-returning method round-trips",
      Effect.gen(function* () {
        const result = yield* inWorker<{ values: number[] }>("/stream/w-a?n=4");
        expect(result.values).toEqual([1, 2, 3, 4]);
      }),
      { timeout: 120_000 },
    );

    test(
      "in-worker: a typed Effect.fail keeps its tag",
      Effect.gen(function* () {
        const result = yield* inWorker<{ tag: string }>("/fail/w-a");
        expect(result.tag).toBe("CounterBoom");
      }),
      { timeout: 120_000 },
    );

    test(
      "worker-level RPC methods dispatch through the gateway",
      Effect.gen(function* () {
        const result = yield* getJson<{ from: string }>("/worker/rpc");
        expect(result.from).toBe("fleet-worker");
      }),
      { timeout: 120_000 },
    );

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
          getJson<{ values: number[] }>(`/affinity/affinity-probe?n=${n}`).pipe(
            Effect.map((value) => value.values),
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
      getJson<{ status: number; body: string }>(`/probe-unauth/${kind}`);

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
  },
);
