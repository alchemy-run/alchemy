import { pollUntil } from "@/DigitalOcean/poll";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

class TimedOut extends Data.TaggedError("TimedOut")<{
  readonly last: number;
}> {}

const BUDGET = { every: "1 millis", times: 3 } as const;

/** Observes 1, 2, 3, … until the observation reaches `target`. */
const pollUntilReaches = (target: number) => {
  let observations = 0;
  return pollUntil(
    Effect.sync(() => ++observations),
    {
      ...BUDGET,
      until: (observed) => observed >= target,
      onTimeout: (last) => new TimedOut({ last }),
    },
  );
};

describe(
  "pollUntil",
  { tags: ["unit", "provider:digitalocean", "local"] },
  () => {
    it.live("returns the first observation when it already holds", () =>
      Effect.gen(function* () {
        expect(yield* pollUntilReaches(1)).toEqual(1);
      }),
    );

    it.live("observes again until the condition holds", () =>
      Effect.gen(function* () {
        expect(yield* pollUntilReaches(3)).toEqual(3);
      }),
    );

    it.live("fails with the last observation when the budget runs out", () =>
      Effect.gen(function* () {
        const timeout = yield* Effect.flip(pollUntilReaches(10));
        expect(timeout).toBeInstanceOf(TimedOut);
        expect(timeout.last).toEqual(BUDGET.times + 1);
      }),
    );
  },
);
