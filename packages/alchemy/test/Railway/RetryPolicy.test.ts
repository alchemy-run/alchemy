import { waitOutCreateRateLimit } from "@/Railway/transient.ts";
import * as railway from "@distilled.cloud/railway";
import { expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

it.effect(
  "create throttling retries once and releases the gate after exhaustion",
  () =>
    Effect.gen(function* () {
      let attempts = 0;
      const error = new railway.RailwayRateLimited({
        message: "creating environments too quickly",
      });
      const fiber = yield* waitOutCreateRateLimit(
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(error);
        }),
      ).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("60 seconds");
      expect(yield* Fiber.join(fiber)).toBe(error);
      expect(attempts).toBe(2);
      expect(yield* waitOutCreateRateLimit(Effect.succeed("released"))).toBe(
        "released",
      );
    }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("create validation failures propagate without retrying", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const error = new railway.RailwayValidationError({
      message: "invalid input",
    });
    const failure = yield* waitOutCreateRateLimit(
      Effect.suspend(() => {
        attempts++;
        return Effect.fail(error);
      }),
    ).pipe(Effect.flip);
    expect(failure).toBe(error);
    expect(attempts).toBe(1);
  }),
);
