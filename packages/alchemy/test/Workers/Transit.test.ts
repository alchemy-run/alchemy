import { describe, expect, it } from "@alchemy.run/test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { RpcCallError } from "@/Rpc.ts";
import { isOverloaded, isTransitRetryable, retryInTransit } from "@/Workers/Transit.ts";

// The errors workerd rejects a Durable Object call with, shaped the way it
// shapes them: a native Error with `retryable`/`overloaded` own properties.
const native = (message: string, flags: { retryable?: boolean; overloaded?: boolean } = {}) =>
  Object.assign(new Error(message), flags);
const overloaded = () =>
  native("Durable Object is overloaded. Too many requests queued.", {
    retryable: true,
    overloaded: true,
  });
const reset = () =>
  native("Durable Object reset because its code was updated.", { retryable: true });
const notRetryable = () =>
  native("Durable Object storage operation exceeded timeout", { retryable: false });
const internal = () => native("internal error; reference = 0123456789abcdef");
const methodUnavailable = () =>
  new TypeError('The RPC receiver does not implement the method "send".');

// An Effect-wrapped stub reports each of them as an `RpcCallError`.
const stubFailure = (cause: unknown) => new RpcCallError({ method: "send", cause });

/**
 * Run a call that fails with `fail(attempt)` until it returns `undefined`
 * under `retryInTransit`, and report how many attempts it made and how it
 * ended.
 */
const attempts = (fail: (attempt: number) => unknown) =>
  Effect.gen(function* () {
    let count = 0;
    const call = Effect.suspend(() => {
      const error = fail(count++);
      return error === undefined ? Effect.succeed("sent") : Effect.fail(error);
    });
    const fiber = yield* Effect.forkChild(Effect.exit(retryInTransit(call)));
    yield* TestClock.adjust(Duration.hours(1));
    const exit = yield* Fiber.join(fiber);
    return { count, exit };
  });

describe("Transit", { tags: ["unit", "local"] }, () => {
  describe("isTransitRetryable", () => {
    it("does not retry an overloaded object, even when workerd marks it retryable", () => {
      expect(isOverloaded(stubFailure(overloaded()))).toBe(true);
      expect(isTransitRetryable(stubFailure(overloaded()))).toBe(false);
      // A defect from an unwrapped stub carries the native error itself.
      expect(isTransitRetryable(overloaded())).toBe(false);
      expect(isTransitRetryable(native("overloaded", { overloaded: true }))).toBe(false);
    });

    it("does not retry an error workerd marks not retryable", () => {
      expect(isTransitRetryable(stubFailure(notRetryable()))).toBe(false);
      expect(isTransitRetryable(notRetryable())).toBe(false);
    });

    it("retries a reset, an opaque internal error, and an object on the previous code", () => {
      expect(isTransitRetryable(stubFailure(reset()))).toBe(true);
      expect(isTransitRetryable(stubFailure(internal()))).toBe(true);
      expect(isTransitRetryable(stubFailure(methodUnavailable()))).toBe(true);
      expect(isOverloaded(stubFailure(reset()))).toBe(false);
    });

    it("retries failures that carry no workerd flags", () => {
      expect(isTransitRetryable(new Error("Live read upgrade answered 503"))).toBe(true);
      expect(isTransitRetryable("boom")).toBe(true);
      expect(isTransitRetryable(undefined)).toBe(true);
      expect(isTransitRetryable({ _tag: "RpcCallError" })).toBe(true);
    });
  });

  describe("retryInTransit", () => {
    it.effect("makes one call and fails when the object is overloaded", () =>
      Effect.gen(function* () {
        const { count, exit } = yield* attempts((attempt) =>
          attempt === 0 ? stubFailure(overloaded()) : undefined,
        );
        expect(count).toBe(1);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );

    it.effect("makes one call and fails when the error is not retryable", () =>
      Effect.gen(function* () {
        const { count, exit } = yield* attempts((attempt) =>
          attempt === 0 ? stubFailure(notRetryable()) : undefined,
        );
        expect(count).toBe(1);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );

    it.effect("stops at an overload that follows a retried reset", () =>
      Effect.gen(function* () {
        const { count, exit } = yield* attempts((attempt) =>
          attempt === 0
            ? stubFailure(reset())
            : attempt === 1
              ? stubFailure(overloaded())
              : undefined,
        );
        expect(count).toBe(2);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );

    it.effect("retries a reset until the call goes through", () =>
      Effect.gen(function* () {
        const { count, exit } = yield* attempts((attempt) =>
          attempt < 3 ? stubFailure(reset()) : undefined,
        );
        expect(count).toBe(4);
        expect(exit).toEqual(Exit.succeed("sent"));
      }),
    );

    it.effect("gives up on an ordinary transport error after 35 retries", () =>
      Effect.gen(function* () {
        const { count, exit } = yield* attempts(() => stubFailure(internal()));
        expect(count).toBe(36);
        expect(Exit.isFailure(exit)).toBe(true);
      }),
    );
  });
});
