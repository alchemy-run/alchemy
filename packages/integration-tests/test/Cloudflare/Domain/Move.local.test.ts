import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import { call, seedAccounts, seedOne, serving } from "./bench.ts";
import MoveV0 from "./fixtures/move/v0.ts";
import MoveV1 from "./fixtures/move/v1.ts";
import { depositsOf, writer } from "./move.ts";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

const DEPTH = Number(process.env.DOMAIN_MOVE_DEPTH ?? 1000);
const WIDTH = 20;
const SMALL = 5;
const sum = (from: number, to: number) => ((from + to) * (to - from + 1)) / 2;
const json = <A>(url: string, path: string) =>
  call(url, "GET", path).pipe(Effect.map((body) => JSON.parse(body) as A));

/**
 * The move under `alchemy dev`: every key moves on its first call (no deploy
 * runs the migration locally). A deep account written and read throughout
 * its move loses and repeats nothing, and its view receives every deposit.
 */
test.provider(
  "dev: accounts written and read throughout their move lose and repeat nothing",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { worker } = yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* MoveV0 };
        }),
      );
      const url = worker.url!.replace(/\/+$/, "");
      yield* serving(url, "v0");
      yield* seedOne(url, "deep", DEPTH);
      yield* seedAccounts(url, WIDTH, SMALL);
      // The view has every seeded deposit before the move.
      yield* depositsOf(url, "deep").pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (view) => view?.count === DEPTH,
          times: 120,
        }),
      );

      const log = { written: [] as Array<number>, failures: [] as Array<string>, stop: false };
      const writing = yield* Effect.forkChild(writer(url, "deep", DEPTH + 1, log));
      yield* Effect.sleep("2 seconds");
      yield* stack.deploy(
        Effect.gen(function* () {
          return { worker: yield* MoveV1 };
        }),
      );
      yield* serving(url, "v1");
      yield* Effect.sleep("10 seconds");
      log.stop = true;
      yield* Fiber.join(writing);

      let deepTotal = sum(1, DEPTH) + log.written.reduce((total, amount) => total + amount, 0);
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
        view = yield* settle;
      }
      expect(view.missing).toEqual([]);
      expect(view.repeated).toBe(0);
      for (const i of [0, WIDTH - 1])
        expect(yield* depositsOf(url, `b${i}`)).toMatchObject({
          count: SMALL,
          total: sum(1, SMALL),
        });
      yield* stack.destroy();
    }),
  { timeout: 900_000, tags: ["provider:cloudflare", "provider:cloudflare:worker", "local"] },
);
