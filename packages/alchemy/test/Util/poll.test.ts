import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { pollUntil } from "@/Util/poll";

class TimedOut extends Data.TaggedError("TimedOut")<{
  readonly last: number;
}> {}

// The backoff starts at 500ms and grows by 1.5× up to `every`.
const BUDGET = { every: "3 seconds", times: 3 } as const;

/** Observes 1, 2, 3, … until the observation reaches `target`. */
const countUpTo = (target: number) => {
  let observations = 0;
  const poll = pollUntil(
    Effect.sync(() => ++observations),
    {
      ...BUDGET,
      until: (observed) => observed >= target,
      onTimeout: (last) => new TimedOut({ last }),
    },
  );
  return { poll, observations: () => observations };
};

describe("pollUntil", { tags: ["unit", "local"] }, () => {
  it.effect("returns the first observation when it already holds", () =>
    Effect.gen(function* () {
      expect(yield* countUpTo(1).poll).toEqual(1);
    }),
  );

  it.effect("backs off between observations until the condition holds", () =>
    Effect.gen(function* () {
      const counter = countUpTo(3);
      const fiber = yield* Effect.forkChild(counter.poll);
      yield* TestClock.adjust("500 millis");
      expect(counter.observations()).toEqual(2);
      yield* TestClock.adjust("750 millis");
      expect(yield* Fiber.join(fiber)).toEqual(3);
    }),
  );

  it.effect("fails with the last observation when the budget runs out", () =>
    Effect.gen(function* () {
      const counter = countUpTo(10);
      const fiber = yield* Effect.forkChild(Effect.flip(counter.poll));
      yield* TestClock.adjust("10 seconds");
      const timeout = yield* Fiber.join(fiber);
      expect(timeout).toBeInstanceOf(TimedOut);
      expect(timeout.last).toEqual(BUDGET.times + 1);
    }),
  );
});
