import * as Cloudflare from "@/Cloudflare";
import * as Neon from "@/Neon";
import * as Prisma from "@/Prisma";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "./fixtures/prisma-orm/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Layer.mergeAll(
    Cloudflare.providers(),
    Neon.providers(),
    Prisma.providers(),
  ),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack), { timeout: 300_000 });
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

/** GET with fresh-edge retry: workers.dev serves placeholder errors briefly. */
const getOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        schedule: Schedule.max([
          Schedule.exponential("500 millis"),
          Schedule.recurs(15),
        ]),
      }),
    );
  });

test(
  "prisma-next client round-trips orm queries through Hyperdrive on workerd",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const created = yield* getOk(`${url}/widgets/create/gizmo`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((json) => json as { id: number; name: string }),
    );
    expect(created.name).toEqual("gizmo");
    expect(created.id).toBeGreaterThan(0);

    // Read-after-write in a separate fetch event (separate pool).
    const fetched = yield* getOk(`${url}/widgets/get/${created.id}`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((json) => json as { found: boolean; name: string | null }),
    );
    expect(fetched).toEqual({ found: true, name: "gizmo" });
  }).pipe(logLevel),
  { timeout: 300_000 },
);

test(
  "transactions work inside a single event",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const result = yield* getOk(`${url}/widgets/tx/tx-gizmo`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((json) => json as { name: string | null }),
    );
    expect(result.name).toEqual("tx-gizmo");
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "sql lane and typed rollback on workerd",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const sql = yield* getOk(`${url}/widgets/sql`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((json) => json as { count: number }),
    );
    expect(sql.count).toBeGreaterThanOrEqual(0);

    const rollback = yield* getOk(`${url}/widgets/rollback/ghost-widget`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((json) => json as { outcome: string; visible: boolean }),
    );
    expect(rollback).toEqual({ outcome: "rolled-back", visible: false });
  }).pipe(logLevel),
  { timeout: 120_000 },
);

test(
  "sequential and concurrent events each get their own pool (no cross-request I/O)",
  Effect.gen(function* () {
    const { url } = yield* stack;

    const created = yield* getOk(`${url}/widgets/create/pool-widget`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((json) => json as { id: number }),
    );

    const query = getOk(`${url}/widgets/get/${created.id}`).pipe(
      Effect.flatMap((res) => res.json),
      Effect.map((json) => json as { found: boolean }),
    );

    // Sequential events reuse nothing across requests.
    for (let i = 0; i < 3; i++) {
      expect((yield* query).found).toBe(true);
    }

    // Concurrent events: workerd kills cross-request I/O ("Cannot perform
    // I/O on behalf of a different request") and a shared closed pool fails
    // with "Cannot use a pool after calling end" — six parallel queries pin
    // the per-event pool isolation.
    const results = yield* Effect.all(
      Array.from({ length: 6 }, () => query),
      {
        concurrency: "unbounded",
      },
    );
    for (const result of results) {
      expect(result.found).toBe(true);
    }
  }).pipe(logLevel),
  { timeout: 120_000 },
);
