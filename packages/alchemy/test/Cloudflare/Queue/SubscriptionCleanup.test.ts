import { describe, expect, test } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeSubscriptionCleanup } from "./SubscriptionCleanup.ts";

describe("subscription cleanup", () => {
  test.effect("returns successful cleanup results", () =>
    Effect.gen(function* () {
      const cleanup = makeSubscriptionCleanup();
      expect(yield* cleanup(Effect.succeed(42))).toBe(42);
    }),
  );

  test.effect("preserves cleanup failures", () =>
    Effect.gen(function* () {
      const cleanup = makeSubscriptionCleanup();
      const result = yield* cleanup(
        Effect.fail(new Error("delete failed")),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).toContain("delete failed");
    }),
  );

  test.effect("bounds a stalled release inside scope finalization", () =>
    Effect.gen(function* () {
      const cleanup = makeSubscriptionCleanup();
      const fiber = yield* Effect.acquireRelease(Effect.void, () =>
        cleanup(Effect.never),
      ).pipe(
        Effect.scoped,
        Effect.exit,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("5 seconds");
      const result = yield* Fiber.join(fiber);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result))
        expect(Cause.pretty(result.cause)).toContain("TimeoutError");
    }),
  );

  test.effect(
    "shares one deadline across releases and stops starting work when exhausted",
    () =>
      Effect.gen(function* () {
        const cleanup = makeSubscriptionCleanup();
        yield* cleanup(Effect.void);
        yield* TestClock.adjust("19 seconds");
        const fiber = yield* cleanup(Effect.never).pipe(
          Effect.exit,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 second");
        expect(Exit.isFailure(yield* Fiber.join(fiber))).toBe(true);
        let started = false;
        const result = yield* cleanup(
          Effect.sync(() => {
            started = true;
          }),
        ).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        expect(started).toBe(false);
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain(
            "Subscription cleanup deadline exceeded",
          );
      }),
  );
});
