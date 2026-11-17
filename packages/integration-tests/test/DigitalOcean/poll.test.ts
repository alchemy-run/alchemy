import { pollUntil } from "@alchemy.run/digitalocean/internal/poll";
import { describe, expect, it } from "@alchemy.run/test";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

class TimedOut extends Data.TaggedError("TimedOut")<{
  readonly last: number;
}> {}

/** Polls the test clock until `until` holds, recording when each observation ran. */
const pollClock = Effect.fn(function* (until: (now: number) => boolean) {
  const observedAt = yield* Ref.make<ReadonlyArray<number>>([]);
  const observe = Clock.currentTimeMillis.pipe(
    Effect.tap((now) => Ref.update(observedAt, Arr.append(now))),
  );
  const poll = pollUntil(observe, {
    maxDelay: "1 second",
    times: 4,
    until,
    onTimeout: (last) => new TimedOut({ last }),
  });
  return { poll, observedAt: Ref.get(observedAt) };
});

const runOnTestClock = Effect.fn(function* <A, E>(poll: Effect.Effect<A, E>) {
  const fiber = yield* Effect.forkChild(poll);
  yield* TestClock.adjust("1 minute");
  return yield* Fiber.join(fiber);
});

describe("pollUntil", { tags: ["unit", "provider:digitalocean", "local"] }, () => {
  it.effect("returns the first observation when it already holds", () =>
    Effect.gen(function* () {
      const { poll, observedAt } = yield* pollClock(() => true);
      expect(yield* poll).toEqual(0);
      expect(yield* observedAt).toEqual([0]);
    }),
  );

  it.effect("returns the first observation that holds", () =>
    Effect.gen(function* () {
      const { poll, observedAt } = yield* pollClock((now) => now >= 1000);
      expect(yield* runOnTestClock(poll)).toEqual(1250);
      expect(yield* observedAt).toEqual([0, 500, 1250]);
    }),
  );

  it.effect("waits 500ms, then 1.5× longer each time, never longer than `maxDelay`", () =>
    Effect.gen(function* () {
      const { poll, observedAt } = yield* pollClock(() => false);
      yield* runOnTestClock(Effect.flip(poll));
      expect(yield* observedAt).toEqual([0, 500, 1250, 2250, 3250]);
    }),
  );

  it.effect("fails with the last observation once `times` retries are spent", () =>
    Effect.gen(function* () {
      const { poll } = yield* pollClock(() => false);
      const timeout = yield* runOnTestClock(Effect.flip(poll));
      expect(timeout).toBeInstanceOf(TimedOut);
      expect(timeout.last).toEqual(3250);
    }),
  );
});
