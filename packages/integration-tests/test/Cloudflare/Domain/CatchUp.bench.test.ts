import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import { call, EVENTS, now, seedAccounts, seedOne, serving, settledUsage } from "./bench.ts";
import BenchV1 from "./fixtures/bench/v1.ts";
import BenchV2Summary from "./fixtures/bench/v2-summary.ts";
import BenchV2Total from "./fixtures/bench/v2-total.ts";
import BenchV2 from "./fixtures/bench/v2.ts";

/**
 * What a backfill costs and how long a deploy waits for it on Cloudflare. Each
 * run deploys accounts, seeds history, then deploys a view and reads the
 * Durable Object requests and SQLite rows of its backfill from Cloudflare's
 * analytics, printing a `BENCH` line of JSON. Three shapes:
 *
 * - width (`DOMAIN_BENCH_INSTANCES`, default 1000): N accounts with 10 deposits
 *   each, then a view keyed by account;
 * - depth (`DOMAIN_BENCH_DEPTH`, default 1000): one account with N deposits,
 *   then a summary per account;
 * - bank-wide (`DOMAIN_BENCH_TOTAL`, `<accounts>x<events>`, default 100x100):
 *   accounts with deposits, then one total that every account feeds.
 *
 * Sizes are comma-separated; an empty variable skips that shape.
 */

const list = (name: string, fallback: string) =>
  (process.env[name] ?? fallback).split(",").filter((size) => size !== "");
const widths = list("DOMAIN_BENCH_INSTANCES", "1000").map(Number);
const depths = list("DOMAIN_BENCH_DEPTH", "1000").map(Number);
const totals = list("DOMAIN_BENCH_TOTAL", "100x100").map(
  (size) => size.split("x").map(Number) as [number, number],
);

const { test } = Test.make({ providers: Cloudflare.providers() });

type Next = typeof BenchV2 | typeof BenchV2Summary | typeof BenchV2Total;

/**
 * Deploy accounts, seed them, deploy `next` and wait for its backfill; check
 * the view, then read the backfill's usage from analytics.
 */
const run = (
  stack: Test.ScratchStack,
  shape: Record<string, unknown> & { readonly events: number; readonly instances: number },
  seed: (url: string) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
  next: Next,
  check: (url: string) => Effect.Effect<void, unknown, HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    yield* stack.destroy();
    const { worker } = yield* stack.deploy(
      Effect.gen(function* () {
        return { worker: yield* BenchV1 };
      }),
    );
    const url = worker.url!.replace(/\/+$/, "");
    const scriptName = worker.workerName;
    yield* serving(url, "v1");

    // History before the view exists.
    const seedStart = yield* now;
    yield* seed(url);
    const seedEnd = yield* now;
    // Keep the seed out of the backfill's analytics window.
    yield* Effect.sleep("2 minutes");

    const deployStart = yield* now;
    yield* stack.deploy(
      Effect.gen(function* () {
        return { worker: yield* next };
      }),
    );
    const deployEnd = yield* now;
    yield* serving(url, "v2");

    // The deploy returned once the backfill was done.
    const history = JSON.parse(yield* call(url, "GET", "/history")) as { complete: boolean };
    expect(history.complete).toBe(true);
    yield* check(url);

    const timing = {
      ...shape,
      deploySeconds: +((deployEnd.getTime() - deployStart.getTime()) / 1000).toFixed(1),
      seedSeconds: +((seedEnd.getTime() - seedStart.getTime()) / 1000).toFixed(1),
    };
    // DOMAIN_BENCH_TIME_ONLY: report the deploy's time without waiting minutes for analytics.
    if (process.env.DOMAIN_BENCH_TIME_ONLY) {
      yield* Effect.sync(() => console.log(`BENCH ${JSON.stringify(timing)}`));
      return yield* stack.destroy();
    }
    const settleEnd = new Date(deployEnd.getTime() + 2 * 60_000);
    const seedUsage = yield* settledUsage(scriptName, seedStart, seedEnd);
    const backfill = yield* settledUsage(scriptName, deployStart, settleEnd);
    const result = {
      ...timing,
      backfill,
      seed: seedUsage,
      requestsPerInstance: +(backfill.requests / shape.instances).toFixed(2),
      rowsWrittenPerEvent: +(backfill.rowsWritten / shape.events).toFixed(2),
      rowsReadPerEvent: +(backfill.rowsRead / shape.events).toFixed(2),
    };
    yield* Effect.sync(() => console.log(`BENCH ${JSON.stringify(result)}`));
    yield* stack.destroy();
  });

const viewOf = (url: string, key: string) =>
  call(url, "GET", `/view/${key}`).pipe(Effect.map((body) => JSON.parse(body)));

// Each run has its own Worker and stack: run them at once, or a full sweep takes hours.
describe.concurrent(
  "live backfill benchmarks",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    for (const instances of widths) {
      test.provider.skipIf(!!process.env.FAST)(
        `live: backfill of ${instances} instances with ${EVENTS} events each`,
        (stack) =>
          run(
            stack,
            { shape: "width", instances, events: instances * EVENTS },
            (url) => seedAccounts(url, instances, EVENTS),
            BenchV2,
            (url) =>
              Effect.gen(function* () {
                const expected = Array.from({ length: EVENTS }, (_, n) => n + 1);
                for (const i of [0, Math.floor(instances / 2), instances - 1]) {
                  const account = JSON.parse(yield* call(url, "GET", `/account/b${i}`)) as {
                    balance: number;
                  };
                  expect(account.balance).toBe((EVENTS * (EVENTS + 1)) / 2);
                  expect(
                    ((yield* viewOf(url, `b${i}`)) as { amounts: Array<number> }).amounts,
                  ).toEqual(expected);
                }
              }),
          ),
        { timeout: 7_200_000 },
      );
    }

    for (const events of depths) {
      test.provider.skipIf(!!process.env.FAST)(
        `live: backfill of one account with ${events} events`,
        (stack) =>
          run(
            stack,
            { shape: "depth", instances: 1, events },
            (url) => seedOne(url, "deep", events),
            BenchV2Summary,
            (url) =>
              Effect.gen(function* () {
                expect(yield* viewOf(url, "deep")).toEqual({
                  count: events,
                  total: (events * (events + 1)) / 2,
                });
              }),
          ),
        { timeout: 7_200_000 },
      );
    }

    for (const [accounts, events] of totals) {
      test.provider.skipIf(!!process.env.FAST)(
        `live: backfill of a bank-wide total over ${accounts} accounts with ${events} events each`,
        (stack) =>
          run(
            stack,
            { shape: "total", instances: accounts, events: accounts * events },
            (url) => seedAccounts(url, accounts, events),
            BenchV2Total,
            (url) =>
              Effect.gen(function* () {
                expect(yield* viewOf(url, "bank")).toEqual({
                  count: accounts * events,
                  total: (accounts * events * (events + 1)) / 2,
                });
              }),
          ),
        { timeout: 7_200_000 },
      );
    }
  },
);
