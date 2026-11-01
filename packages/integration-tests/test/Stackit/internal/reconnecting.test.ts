import { AmqpError, reconnecting } from "@alchemy.run/stackit/RabbitMQ/AmqpDriver";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

const lost = new AmqpError({ message: "RabbitMQ connection closed" });

/** Plenty of virtual time for a whole budget of the longest backoffs. */
const EVERYTHING = "2 hours";

describe("reconnecting", () => {
  it.effect("gives up after 20 consecutive failures, with the error", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* reconnecting(() =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(lost);
        }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(EVERYTHING);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(attempts).toEqual(21);
    }),
  );

  it.effect("a consumer that never comes up can't reset the budget, however slow it fails", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* reconnecting(() =>
        Effect.suspend(() => {
          attempts++;
          return Effect.sleep("2 minutes").pipe(Effect.andThen(Effect.fail(lost)));
        }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("3 hours");
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(attempts).toEqual(21);
    }),
  );

  it.effect("a loss after a healthy period starts over, so restarts days apart never add up", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* reconnecting((onConsuming) =>
        Effect.suspend(() => {
          attempts++;
          return attempts > 100
            ? Effect.never
            : onConsuming.pipe(
                Effect.andThen(Effect.sleep("1 hour")),
                Effect.andThen(Effect.fail(lost)),
              );
        }),
      ).pipe(Effect.forkChild);
      // Far more losses than the budget, each after an hour of consuming.
      yield* TestClock.adjust("120 hours");
      expect(attempts).toBeGreaterThan(100);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("waits one second after the first loss of a healthy connection", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fiber = yield* reconnecting((onConsuming) =>
        Effect.suspend(() => {
          attempts++;
          return attempts === 1
            ? onConsuming.pipe(
                Effect.andThen(Effect.sleep("1 minute")),
                Effect.andThen(Effect.fail(lost)),
              )
            : Effect.never;
        }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      expect(attempts).toEqual(1);
      yield* TestClock.adjust("1 second");
      expect(attempts).toEqual(2);
      yield* Fiber.interrupt(fiber);
    }),
  );
});
