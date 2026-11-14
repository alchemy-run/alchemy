import { describe, expect, it } from "@alchemy.run/test";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as DeployRetry from "@/DeployRetry";

// Errors carrying distilled's marks the way its error classes do.
const marked = (tag: string, categories: string[], fields: object = {}) => ({
  _tag: tag,
  ...fields,
  "@distilled.cloud/error/categories": Object.fromEntries(categories.map((c) => [c, true])),
});
const ServerError = () => marked("InternalServerError", ["ServerError"]);
const Throttled = (fields: object = {}) => marked("TooManyRequests", ["ThrottlingError"], fields);
const BadRequest = () => marked("BadRequest", ["BadRequestError"]);
const RetryableMarked = {
  _tag: "Busy",
  "@distilled.cloud/error/retryable": {},
};

/**
 * The times of each attempt of a call that fails with `fail(attempt)` until
 * it returns `undefined`, run under the policy the way distilled runs a
 * factory policy: the schedule sees each failure through `lastError`.
 */
const attemptTimes = (fail: (attempt: number) => unknown) =>
  Effect.gen(function* () {
    const times: number[] = [];
    const lastError = yield* Ref.make<unknown>(undefined);
    const options = DeployRetry.policy(lastError);
    const call = Effect.flatMap(Clock.currentTimeMillis, (now) => {
      times.push(now);
      const error = fail(times.length - 1);
      return error === undefined ? Effect.void : Effect.fail(error);
    }).pipe(Effect.tapError((e) => Ref.set(lastError, e)));
    const fiber = yield* Effect.forkChild(
      Effect.result(Effect.retry(call, { while: options.while!, schedule: options.schedule! })),
    );
    yield* TestClock.adjust(Duration.hours(1));
    yield* Fiber.join(fiber);
    return times.slice(1).map((t, i) => t - times[i]!);
  });

describe("DeployRetry", { tags: ["unit", "local"] }, () => {
  it.effect("backs off from 250ms, capped at 5s, and gives up after 8 retries", () =>
    Effect.gen(function* () {
      const random = Math.random;
      Math.random = () => 0;
      try {
        const delays = yield* attemptTimes(() => ServerError());
        expect(delays).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 5000]);
      } finally {
        Math.random = random;
      }
    }),
  );

  it.effect("throttling waits at least 500ms", () =>
    Effect.gen(function* () {
      const random = Math.random;
      Math.random = () => 0;
      try {
        const delays = yield* attemptTimes((n) => (n < 3 ? Throttled() : undefined));
        expect(delays).toEqual([500, 500, 1000]);
      } finally {
        Math.random = random;
      }
    }),
  );

  it.effect("a server hint replaces the backoff, capped at 60s", () =>
    Effect.gen(function* () {
      const random = Math.random;
      Math.random = () => 0;
      try {
        const hinted = (seconds: number) => Throttled({ retryAfter: Duration.seconds(seconds) });
        const delays = yield* attemptTimes((n) =>
          n === 0 ? hinted(0) : n === 1 ? hinted(30) : n === 2 ? hinted(600) : undefined,
        );
        expect(delays).toEqual([0, 30_000, 60_000]);
      } finally {
        Math.random = random;
      }
    }),
  );

  it.effect("adds up to 50ms of jitter", () =>
    Effect.gen(function* () {
      const random = Math.random;
      Math.random = () => 0.5;
      try {
        const delays = yield* attemptTimes((n) => (n < 2 ? ServerError() : undefined));
        expect(delays).toEqual([275, 525]);
      } finally {
        Math.random = random;
      }
    }),
  );

  it("retries transient categories and nothing else", () => {
    expect(DeployRetry.isTransient(ServerError())).toBe(true);
    expect(DeployRetry.isTransient(Throttled())).toBe(true);
    expect(DeployRetry.isTransient(RetryableMarked)).toBe(true);
    expect(DeployRetry.isTransient(BadRequest())).toBe(false);
    expect(DeployRetry.isTransient(new Error("plain"))).toBe(false);
  });
});
