/**
 * Repro probe: does a bounded retry loop inside a provider `delete` iterate
 * under the engine's destroy driver? Mirrors the exact shape of CloudFront
 * Distribution's `waitForDeletionReady` (typed not-ready error, per-poll
 * Effect.timeout, Effect.retry with Schedule.max([fixed, recurs])) — the
 * live Router runs observed this loop doing ONE poll then going silent.
 */
import * as Provider from "@/Provider.ts";
import { Resource } from "@/Resource";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

interface SlowGone extends Resource<"Test.SlowGone", {}, { name: string }> {}
const SlowGone = Resource<SlowGone>("Test.SlowGone");

class PendingDeletionReadiness extends Data.TaggedError(
  "PendingDeletionReadiness",
)<{ message: string }> {}

let polls = 0;
const stamps: number[] = [];

const slowGoneProvider = () =>
  Provider.succeed(SlowGone, {
    reconcile: Effect.fn(function* ({ id, output }) {
      return output ?? { name: id };
    }),
    delete: Effect.fn(function* () {
      yield* Effect.logInfo("probe delete: waiting for deletion readiness");
      yield* Effect.logInfo("probe delete: waiting for deletion readiness").pipe(
        Effect.andThen(() =>
          Effect.sync(() => {
            polls++;
            stamps.push(Date.now());
          }).pipe(
            Effect.timeout(30_000),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(
                new PendingDeletionReadiness({ message: "poll timed out" }),
              ),
            ),
          ),
        ),
        Effect.flatMap(() =>
          polls >= 5
            ? Effect.logInfo(`probe delete: ready after ${polls} polls`)
            : Effect.logInfo(`probe delete: not ready poll=${polls}`).pipe(
                Effect.andThen(() =>
                  Effect.fail(
                    new PendingDeletionReadiness({ message: "not ready" }),
                  ),
                ),
              ),
        ),
        Effect.retry({
          while: (error) => error._tag === "PendingDeletionReadiness",
          schedule: Schedule.max([
            Schedule.fixed("2 seconds"),
            Schedule.recurs(60),
          ]),
        }),
      );
    }),
  });

const { test } = Test.make({ providers: slowGoneProvider() });

describe("delete retry probe", () => {
  test.provider(
    "bounded retry inside provider delete iterates under the destroy driver",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const gone = yield* SlowGone("Probe", {});
            return { gone };
          }),
        );

        yield* stack.destroy();

        expect(polls).toBe(5);
        // 4 retry sleeps of ~2s each — proves the schedule actually paced.
        expect(stamps[stamps.length - 1]! - stamps[0]!).toBeGreaterThan(6_000);
      }),
    { timeout: 60_000, retry: 0 },
  );
});
