import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { call, now, seedAccounts, seedOne, serving, settledUsage } from "./bench.ts";
import MoveV0 from "./fixtures/move/v0.ts";
import MoveV1 from "./fixtures/move/v1.ts";
import MoveV1b from "./fixtures/move/v1b.ts";
import {
  backdatePasses,
  depositsOf,
  movedBy,
  namespacesOf,
  tagsOf,
  untilListed,
  writer,
} from "./move.ts";

/**
 * Moving a Domain from the classes of Domain version 0 (one per definition)
 * to the one class of version 1, on Cloudflare, while it serves.
 *
 * Every key's new object forwards its calls to the old object, which keeps
 * serving, while it copies the old object's storage in the background; then it
 * seals the old object and takes over in one short step. The deploy runs a
 * fan-out over every old object and waits until each has moved.
 *
 * - stress: a deep account (`DOMAIN_MOVE_DEPTH` deposits, default 3000) and
 *   many small ones, written to and read throughout the move: no request
 *   fails, no deposit is lost or applied twice, and the view agrees;
 * - benchmark (`DOMAIN_MOVE_BENCH_INSTANCES`, default 1000): N accounts with
 *   10 deposits each and their summaries, moved by one deploy, printing a
 *   `BENCH` line of JSON with the deploy's time and the move's usage, to
 *   compare with the backfill benchmark's same width (`CatchUp.bench.test.ts`).
 */

const { test } = Test.make({ providers: Cloudflare.providers() });

const DEPTH = Number(process.env.DOMAIN_MOVE_DEPTH ?? 3000);
const WIDTH = 100;
const SMALL = 5;
const widths = (process.env.DOMAIN_MOVE_BENCH_INSTANCES ?? "1000")
  .split(",")
  .filter((size) => size !== "")
  .map(Number);

const sum = (from: number, to: number) => ((from + to) * (to - from + 1)) / 2;

const json = <A>(url: string, path: string) =>
  call(url, "GET", path).pipe(Effect.map((body) => JSON.parse(body) as A));

describe("moving a Domain to one class", { tags: ["provider:cloudflare", "live"] }, () => {
  test.provider(
    "stress: accounts written and read throughout their move lose and repeat nothing",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { worker } = yield* stack.deploy(
          Effect.gen(function* () {
            return { worker: yield* MoveV0 };
          }),
        );
        const url = worker.url!.replace(/\/+$/, "");
        const scriptName = worker.workerName;
        yield* serving(url, "v0");

        // A deep account (its copy takes many pages) and many small ones.
        yield* seedOne(url, "deep", DEPTH);
        yield* seedAccounts(url, WIDTH, SMALL);
        const legacy = yield* namespacesOf(scriptName);
        // (Cloudflare lists a class shortly after it is created: the run's may not be yet.)
        expect(Object.keys(legacy)).toEqual(
          expect.arrayContaining(["Ledger.AccountAggregate", "Ledger.DepositsView"]),
        );
        // The deploy's run moves what Cloudflare lists: wait until it lists them.
        yield* untilListed([legacy["Ledger.AccountAggregate"]!], (count) => count > WIDTH);

        // Write to the deep account all through the move: each deposit lands
        // on the old object until its key flips, then on the new one.
        const log = { written: [] as Array<number>, failures: [] as Array<string>, stop: false };
        const writing = yield* Effect.forkChild(writer(url, "deep", DEPTH + 1, log));
        yield* stack.deploy(
          Effect.gen(function* () {
            return { worker: yield* MoveV1 };
          }),
        );
        yield* serving(url, "v1");
        yield* Effect.sleep("5 seconds");
        log.stop = true;
        yield* Fiber.join(writing);

        expect(log.failures).toEqual([]);
        expect(log.written.length).toBeGreaterThan(10);
        // Every deposit, once: the seed's and the writer's.
        let deepTotal = sum(1, DEPTH) + log.written.reduce((total, amount) => total + amount, 0);
        expect(yield* json<{ balance: number }>(url, "/account/deep")).toEqual({
          balance: deepTotal,
        });
        // The view is eventually consistent: deliveries the move held up arrive.
        const viewStart = yield* now;
        const expected = [...Array.from({ length: DEPTH }, (_, n) => n + 1), ...log.written];
        const settle = Effect.suspend(() => depositsOf(url, "deep", expected)).pipe(
          Effect.tap((view) =>
            Effect.sync(() =>
              console.log(
                `MOVE-VIEW count=${view.count} of ${expected.length} repeated=${view.repeated} missing=${JSON.stringify(view.missing.slice(0, 40))}${view.missing.length > 40 ? "..." : ""}`,
              ),
            ),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (view) => view.count === expected.length,
            times: 24,
          }),
        );
        let view = yield* settle;
        // Still short: one more deposit makes the account drain its outbox again. If
        // the view then catches up, deliveries were held up, not lost.
        if (view.missing.length > 0) {
          console.log(`MOVE-KICK missing=${view.missing.length}`);
          yield* call(url, "POST", `/deposit/deep/${9_000_000}/1`);
          expected.push(9_000_000);
          deepTotal += 9_000_000;
          deepTotal += 9_000_000;
          view = yield* settle;
        }
        expect(view.missing).toEqual([]);
        expect(view.repeated).toBe(0);
        for (const i of [0, Math.floor(WIDTH / 2), WIDTH - 1]) {
          expect(yield* json(url, `/account/b${i}`)).toEqual({ balance: sum(1, SMALL) });
          expect(yield* depositsOf(url, `b${i}`)).toMatchObject({
            count: SMALL,
            total: sum(1, SMALL),
          });
        }
        // The deploy's run moved them: the accounts, their summaries, the directory.
        expect(yield* movedBy(scriptName)).toBeGreaterThan(WIDTH);
        expect(yield* tagsOf(scriptName)).toContain("alchemy:domain:v1");

        // Once the move has settled, an upload deletes every old class, and
        // everything is still there.
        yield* backdatePasses(scriptName, Object.keys(legacy));
        yield* stack.deploy(
          Effect.gen(function* () {
            return { worker: yield* MoveV1b };
          }),
        );
        yield* serving(url, "v1b");
        expect(Object.keys(yield* namespacesOf(scriptName))).toEqual(["AlchemyDomain"]);
        expect(yield* json(url, "/account/deep")).toEqual({ balance: deepTotal });
        expect(yield* json(url, `/account/b${WIDTH - 1}`)).toEqual({ balance: sum(1, SMALL) });
        // And it takes new writes.
        yield* call(url, "POST", `/deposit/deep/${10_000_000}/1`);
        expect(yield* json(url, "/account/deep")).toEqual({ balance: deepTotal + 10_000_000 });

        yield* stack.destroy();
      }),
    { timeout: 2_400_000 },
  );
});

describe.concurrent(
  "live move benchmarks",
  { tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"] },
  () => {
    for (const instances of widths) {
      test.provider.skipIf(!!process.env.FAST)(
        `live: moving ${instances} accounts with 10 events each and their summaries`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const { worker } = yield* stack.deploy(
              Effect.gen(function* () {
                return { worker: yield* MoveV0 };
              }),
            );
            const url = worker.url!.replace(/\/+$/, "");
            const scriptName = worker.workerName;
            yield* serving(url, "v0");
            yield* seedAccounts(url, instances, 10);
            const legacy = yield* namespacesOf(scriptName);
            yield* untilListed(
              [legacy["Ledger.AccountAggregate"]!, legacy["Ledger.DepositsView"]!],
              (count) => count >= instances,
            );

            const deployStart = yield* now;
            yield* stack.deploy(
              Effect.gen(function* () {
                return { worker: yield* MoveV1 };
              }),
            );
            const deployEnd = yield* now;
            yield* serving(url, "v1");
            const moved = yield* movedBy(scriptName);
            expect(moved).toBeGreaterThanOrEqual(2 * instances);
            for (const i of [0, Math.floor(instances / 2), instances - 1]) {
              expect(yield* json(url, `/account/b${i}`)).toEqual({ balance: sum(1, 10) });
              expect(yield* depositsOf(url, `b${i}`)).toMatchObject({
                count: 10,
                total: sum(1, 10),
              });
            }
            const timing = {
              shape: "move",
              instances,
              objects: moved,
              deploySeconds: +((deployEnd.getTime() - deployStart.getTime()) / 1000).toFixed(1),
              objectsPerSecond: +(
                moved /
                ((deployEnd.getTime() - deployStart.getTime()) / 1000)
              ).toFixed(1),
            };
            if (process.env.DOMAIN_BENCH_TIME_ONLY) {
              yield* Effect.sync(() => console.log(`BENCH ${JSON.stringify(timing)}`));
              return yield* stack.destroy();
            }
            const usage = yield* settledUsage(
              scriptName,
              deployStart,
              new Date(deployEnd.getTime() + 2 * 60_000),
            );
            yield* Effect.sync(() =>
              console.log(
                `BENCH ${JSON.stringify({
                  ...timing,
                  move: usage,
                  requestsPerObject: +(usage.requests / moved).toFixed(2),
                })}`,
              ),
            );
            yield* stack.destroy();
          }),
        { timeout: 7_200_000 },
      );
    }
  },
);
