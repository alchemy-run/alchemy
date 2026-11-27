import * as Cluster from "@alchemy.run/effect-cluster";
import * as Railway from "@alchemy.run/railway";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { railwayApi } from "../Railway/limit.ts";
import { conformanceTests, NotReady, waitForReady } from "./conformance.ts";
import ReplicasFront from "./fixtures/railway-replicas/front.ts";
import OneLive from "./fixtures/railway-replicas/one-live.ts";
import type { Replicas } from "./fixtures/railway-replicas/replica.ts";
import ThreeLive from "./fixtures/railway-replicas/three-live.ts";
import Front from "./fixtures/railway/front.ts";
import { Lives } from "./fixtures/railway/index.ts";
import { scheduledConformanceTests } from "./scheduled-conformance.ts";
import { workflowConformanceTests } from "./workflow-conformance.ts";

const testOptions = { providers: Layer.mergeAll(Railway.providers(), Cluster.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ClusterRailway", import.meta.url);

let baseUrl = "";

// The Effect Cluster conformance cases, against Railway Postgres and a
// runner Service per pool, called from a public Railway Service through the
// gateways on the project's private network.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on Railway (Railway Postgres, Railway Service runners)",
  { tags: ["provider:cluster", "provider:railway", "live"] },
  () => {
    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* sharedStack.destroy();
        const { url } = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const front = yield* Front;
            return { url: front.url };
          }).pipe(Effect.provide(Lives)),
        );
        expect(url).toBeTruthy();
        baseUrl = String(url).replace(/\/+$/, "");
        yield* waitForReady(baseUrl);
      }),
      // Only deploy and destroy drive Railway's API. The cases call the front.
      { timeout: 1_800_000, exclusive: railwayApi },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
      timeout: 1_200_000,
      exclusive: railwayApi,
    });

    conformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    workflowConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
    scheduledConformanceTests(test as never, { baseUrl: () => baseUrl, kind: "live" });
  },
);

const replicasStack = Core.scratchStack(testOptions, "ClusterRailwayReplicas", import.meta.url);
let replicasUrl = "";

/** The pool at a replica count, with its front, deployed. */
const deployReplicas = (live: Layer.Layer<Replicas, never, any>) =>
  replicasStack
    .deploy(
      Effect.gen(function* () {
        const front = yield* ReplicasFront;
        return { url: front.url };
      }).pipe(Effect.provide(live)),
    )
    .pipe(
      Effect.tap(({ url }) =>
        Effect.suspend(() => {
          replicasUrl = String(url).replace(/\/+$/, "");
          return untilAnswered<unknown>("/ready", 120);
        }),
      ),
    );

/** GET a front route and decode its JSON; a non-200 answer fails. */
const call = <T>(path: string) =>
  HttpClient.get(
    `${replicasUrl}${path}`,
    path.startsWith("/crash/")
      ? { headers: { authorization: `Bearer ${process.env.TEST_RAILWAY_CRASH_KEY}` } }
      : undefined,
  ).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? (response.json as Effect.Effect<T, unknown>)
        : Effect.flatMap(response.text, (body) =>
            Effect.fail(
              new NotReady({ detail: `${path}: ${response.status} ${body.slice(0, 300)}` }),
            ),
          ),
    ),
    Effect.timeout("20 seconds"),
  );

/** Call until it answers, for at most `seconds`. */
const untilAnswered = <T>(path: string, seconds: number) =>
  call<T>(path).pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: seconds }));

type WhereShape = { service: string; replica: string; addresses: string[] };

/** Where each of `n` fresh entity ids runs. */
const placements = (prefix: string, n: number) =>
  Effect.forEach(
    Array.from({ length: n }, (_, i) => `${prefix}-${i}`),
    (id) =>
      Effect.map(untilAnswered<WhereShape>(`/where/${id}`, 120), (where) => ({ id, ...where })),
    { concurrency: 6 },
  );

/** Placements of `n` fresh ids, once they run on exactly `replicas` replicas none of `retired`. */
const settledPlacements = (n: number, replicas: number, retired: ReadonlySet<string>) =>
  Effect.suspend(() => placements(`settled-${Date.now()}`, n)).pipe(
    Effect.filterOrFail(
      (all) =>
        new Set(all.map((p) => p.replica)).size === replicas &&
        all.every((p) => !retired.has(p.replica)),
      (all) =>
        new NotReady({
          detail: `entities on ${[...new Set(all.map((p) => p.replica))].join(", ")}`,
        }),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
  );

/** An acknowledged credit: its reply, which a resend of its `txId` must return. */
type Acknowledged = { readonly id: string; readonly tx: string; readonly value: number };

/**
 * Send credits one after another, each to the next of a few entity ids,
 * while `during` runs and for 10 seconds after: what was acknowledged, how
 * many sends failed, and the longest wait between acknowledgements.
 */
const probe = <A, E, R>(label: string, during: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 6 }, (_, i) => `${label}-${Date.now()}-${i}`);
    const acknowledged: Acknowledged[] = [];
    let failed = 0;
    let stopped = false;
    let lastAcknowledged = Date.now();
    let longestGap = 0;
    const sender = Effect.gen(function* () {
      for (let n = 0; !stopped; n++) {
        const id = ids[n % ids.length]!;
        const tx = `${label}-${n}`;
        const sent = yield* call<{ value: number }>(`/credit/${id}/${tx}/1`).pipe(Effect.result);
        if (sent._tag === "Success") {
          const now = Date.now();
          longestGap = Math.max(longestGap, now - lastAcknowledged);
          lastAcknowledged = now;
          acknowledged.push({ id, tx, value: sent.success.value });
        } else {
          failed++;
        }
        yield* Effect.sleep("250 millis");
      }
    });
    const fiber = yield* Effect.forkChild(sender);
    const result = yield* during;
    yield* Effect.sleep("10 seconds");
    stopped = true;
    yield* Fiber.join(fiber);
    longestGap = Math.max(longestGap, Date.now() - lastAcknowledged);
    yield* Effect.log(
      `probe ${label}: ${acknowledged.length} acknowledged, ${failed} failed, longest wait between acknowledgements ${longestGap} ms`,
    );
    return { result, acknowledged, failed, longestGap };
  });

// One pool as replicas of one Railway Service, in one shard group on one
// Postgres: one runner, scaled to three in place, one of them crashed, then
// scaled back to one, with credits sent throughout.
describe.skipIf(!!process.env.FAST)(
  "Effect Cluster on Railway replicas (one Service, one shard group)",
  { tags: ["provider:cluster", "provider:railway", "live"] },
  () => {
    let service = "";
    /** Every credit acknowledged while the pool scaled or a replica crashed. */
    const acknowledged: Acknowledged[] = [];
    /** Every replica that has run the pool's entities. */
    const seen = new Set<string>();

    beforeAll(
      Effect.gen(function* () {
        if (!process.env.NO_DESTROY) yield* replicasStack.destroy();
        yield* deployReplicas(OneLive);
      }),
      { timeout: 1_800_000, exclusive: railwayApi },
    );

    afterAll.skipIf(!!process.env.NO_DESTROY)(replicasStack.destroy(), {
      timeout: 1_200_000,
      exclusive: railwayApi,
    });

    test(
      "one replica runs every entity of the pool",
      Effect.gen(function* () {
        const placed = yield* settledPlacements(12, 1, new Set());
        service = placed[0]!.service;
        for (const p of placed) seen.add(p.replica);
      }),
      { timeout: 300_000 },
    );

    test(
      "the pool scales from one replica to three in place, each under an address of its own",
      Effect.gen(function* () {
        const before = new Set(seen);
        const scaled = yield* probe("up", deployReplicas(ThreeLive));
        acknowledged.push(...scaled.acknowledged);
        // Railway replaces every replica when the count changes.
        const placed = yield* settledPlacements(30, 3, before);
        expect(new Set(placed.map((p) => p.service))).toEqual(new Set([service]));
        expect(new Set(placed.map((p) => p.addresses[0])).size).toBe(3);
        for (const p of placed) seen.add(p.replica);
      }),
      { timeout: 1_800_000, exclusive: railwayApi },
    );

    test(
      "a crashed replica's entities answer again, and its acknowledged persisted messages replay once",
      Effect.gen(function* () {
        const id = `crash-${Date.now()}`;
        const victim = yield* untilAnswered<WhereShape>(`/where/${id}`, 120);
        expect((yield* call<{ value: number }>(`/credit/${id}/tx1/5`)).value).toBe(5);
        expect((yield* call<{ value: number }>(`/credit/${id}/tx2/7`)).value).toBe(12);
        const crashed = yield* probe(
          "crash",
          Effect.gen(function* () {
            const crashedAt = Date.now();
            expect(yield* call<number>(`/crash/${victim.addresses[0]}`)).toBe(200);
            // The reply to tx2 is stored: sent again, it answers 12. Run again
            // on the restarted instance's fresh balance, it would answer 7.
            const replayed = yield* untilAnswered<{ value: number }>(`/credit/${id}/tx2/7`, 180);
            expect(replayed.value).toBe(12);
            return Date.now() - crashedAt;
          }),
        );
        acknowledged.push(...crashed.acknowledged);
        const after = yield* untilAnswered<WhereShape>(`/where/${id}`, 60);
        expect(after.service).toBe(service);
        yield* Effect.log(
          `crashed ${victim.replica}; ${id} answered again after ${crashed.result} ms on ${after.replica}`,
        );
      }),
      { timeout: 600_000, exclusive: true },
    );

    test(
      "the pool scales from three replicas to one in place: same Service, same database",
      Effect.gen(function* () {
        const id = `scale-${Date.now()}`;
        expect((yield* untilAnswered<{ value: number }>(`/credit/${id}/tx1/3`, 120)).value).toBe(3);
        const before = new Set(seen);
        for (const p of yield* placements(`before-${Date.now()}`, 12)) before.add(p.replica);
        const scaled = yield* probe("down", deployReplicas(OneLive));
        acknowledged.push(...scaled.acknowledged);
        const placed = yield* settledPlacements(12, 1, before);
        expect(placed[0]!.service).toBe(service);
        // The stored reply outlived the scale-down: the database is the same one.
        expect((yield* untilAnswered<{ value: number }>(`/credit/${id}/tx1/3`, 120)).value).toBe(3);
      }),
      { timeout: 1_800_000, exclusive: railwayApi },
    );

    test(
      "every credit acknowledged while the pool scaled or crashed replays its stored reply",
      Effect.gen(function* () {
        expect(acknowledged.length).toBeGreaterThan(0);
        // A credit lost would run again on a fresh balance, and one run twice
        // would have stored a later reply: either answers differently.
        const replies = yield* Effect.forEach(
          acknowledged,
          ({ id, tx }) => untilAnswered<{ value: number }>(`/credit/${id}/${tx}/1`, 60),
          { concurrency: 6 },
        );
        expect(replies.map((reply) => reply.value)).toEqual(
          acknowledged.map((credit) => credit.value),
        );
        yield* Effect.log(`${acknowledged.length} acknowledged credits replayed their replies`);
      }),
      { timeout: 600_000 },
    );
  },
);
