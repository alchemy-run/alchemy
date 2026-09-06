import {
  DEFAULT_TIMEOUT_MARGIN_MS,
  HandlerContext,
  InvocationTimeoutError,
  readTimeoutMargin,
  TIMEOUT_IMMINENT_ATTRIBUTE,
  TIMEOUT_MARGIN_ENV,
  toTimeoutMarginMillis,
  withInvocationDeadline,
} from "@/AWS/Lambda/InvocationDeadline.ts";
import type * as lambda from "aws-lambda";
import { afterEach, describe, expect, it } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type * as Tracer from "effect/Tracer";
import { Flusher } from "effect/unstable/observability/OtlpExporter";

const context = (remainingMs: number): lambda.Context =>
  ({
    functionName: "deadline-fn",
    awsRequestId: "req-1",
    getRemainingTimeInMillis: () => remainingMs,
  }) as unknown as lambda.Context;

const withMargin = (value: string | undefined) => {
  if (value === undefined) delete process.env[TIMEOUT_MARGIN_ENV];
  else process.env[TIMEOUT_MARGIN_ENV] = value;
};

/** A `Flusher` that counts drains instead of exporting. */
const countingFlusher = () => {
  const counter = { flushes: 0 };
  const flusher = Flusher.of({
    flush: Effect.sync(() => {
      counter.flushes++;
    }),
    register: () => Effect.void,
  });
  return { counter, flusher };
};

const timeoutFailure = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit)
    ? (
        exit.cause.reasons.find((r) => r._tag === "Fail") as
          | { error: unknown }
          | undefined
      )?.error
    : undefined;

describe("withInvocationDeadline", () => {
  afterEach(() => withMargin(undefined));

  // `it.effect` runs under a TestClock: `Effect.sleep` (and so the guard's
  // deadline timer) only advances through `TestClock.adjust`, which makes
  // every timing below deterministic.
  const start = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.forkChild(Effect.exit(effect));

  it.effect("runs unguarded without a HandlerContext", () =>
    Effect.gen(function* () {
      const fiber = yield* start(
        withInvocationDeadline(
          Effect.sleep("10 seconds").pipe(Effect.as("done")),
        ),
      );
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
    }),
  );

  it.effect("does nothing when the handler finishes within budget", () =>
    Effect.gen(function* () {
      const { counter, flusher } = countingFlusher();
      const fiber = yield* start(
        withInvocationDeadline(
          Effect.sleep("20 millis").pipe(Effect.as("done")),
        ).pipe(
          Effect.provideService(HandlerContext, context(5_000)),
          Effect.provideService(Flusher, flusher),
        ),
      );
      yield* TestClock.adjust("20 millis");
      expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
      expect(counter.flushes).toBe(0);
    }),
  );

  it.effect(
    "at the margin: ends the current span with InvocationTimeoutError, flushes, and lets the handler finish",
    () =>
      Effect.gen(function* () {
        withMargin("4900");
        const { counter, flusher } = countingFlusher();
        let span: Tracer.Span | undefined;
        const fiber = yield* start(
          withInvocationDeadline(
            Effect.gen(function* () {
              span = yield* Effect.currentSpan;
              yield* Effect.sleep("10 seconds");
              return "done late";
            }),
          ).pipe(
            // The tracer middleware puts the http.server span in context
            // OUTSIDE the guard on the real HTTP path; `withSpan` stands in.
            Effect.withSpan("root"),
            Effect.provideService(HandlerContext, context(5_000)),
            Effect.provideService(Flusher, flusher),
          ),
        );

        // 5000 remaining - 4900 margin = a 100 ms budget.
        yield* TestClock.adjust("100 millis");
        expect(counter.flushes).toBe(1);
        expect(span).toBeDefined();
        expect(span!.status._tag).toBe("Ended");
        if (span!.status._tag === "Ended") {
          const error = timeoutFailure(span!.status.exit);
          expect(error).toBeInstanceOf(InvocationTimeoutError);
          const timeout = error as InvocationTimeoutError;
          expect(timeout._tag).toBe("AWS.Lambda.InvocationTimeoutError");
          expect(timeout.name).toBe("AWS.Lambda.InvocationTimeoutError");
          expect(timeout.functionName).toBe("deadline-fn");
          expect(timeout.requestId).toBe("req-1");
          expect(timeout.budgetMs).toBe(100);
          expect(timeout.marginMs).toBe(4900);
          expect(timeout.message).toContain("4900ms before its timeout");
        }
        expect(span!.attributes.get(TIMEOUT_IMMINENT_ATTRIBUTE)).toBe(true);

        // The handler was not touched: it completes on its own schedule and
        // its value comes back, with no second flush. (`Effect.withSpan`
        // leaves an already-ended span alone; the HTTP tracer middleware
        // re-ends it with the real exit — pinned by the dispatch test.)
        yield* TestClock.adjust("10 seconds");
        expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done late"));
        expect(counter.flushes).toBe(1);
        expect(span!.attributes.get(TIMEOUT_IMMINENT_ATTRIBUTE)).toBe(true);
      }),
  );

  it.effect("flushes without a span in context (non-HTTP listeners)", () =>
    Effect.gen(function* () {
      withMargin("4900");
      const { counter, flusher } = countingFlusher();
      const fiber = yield* start(
        withInvocationDeadline(
          Effect.sleep("10 seconds").pipe(Effect.as("done")),
        ).pipe(
          Effect.provideService(HandlerContext, context(5_000)),
          Effect.provideService(Flusher, flusher),
        ),
      );
      yield* TestClock.adjust("100 millis");
      expect(counter.flushes).toBe(1);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
    }),
  );

  it.effect("a margin of 0 disables the flush", () =>
    Effect.gen(function* () {
      withMargin("0");
      const { counter, flusher } = countingFlusher();
      const fiber = yield* start(
        withInvocationDeadline(
          Effect.sleep("50 millis").pipe(Effect.as("done")),
        ).pipe(
          Effect.provideService(HandlerContext, context(10)),
          Effect.provideService(Flusher, flusher),
        ),
      );
      yield* TestClock.adjust("50 millis");
      expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
      expect(counter.flushes).toBe(0);
    }),
  );

  it.effect("a margin that leaves no budget runs unguarded", () =>
    Effect.gen(function* () {
      // default 500 ms margin, 200 ms remaining: budget <= 0
      const { counter, flusher } = countingFlusher();
      const fiber = yield* start(
        withInvocationDeadline(
          Effect.sleep("50 millis").pipe(Effect.as("done")),
        ).pipe(
          Effect.provideService(HandlerContext, context(200)),
          Effect.provideService(Flusher, flusher),
        ),
      );
      yield* TestClock.adjust("50 millis");
      expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
      expect(counter.flushes).toBe(0);
    }),
  );

  it.effect("the innermost guard owns the deadline", () =>
    Effect.gen(function* () {
      withMargin("4900");
      const { counter, flusher } = countingFlusher();
      const fiber = yield* start(
        withInvocationDeadline(
          withInvocationDeadline(
            Effect.sleep("10 seconds").pipe(Effect.as("done")),
          ),
        ).pipe(
          Effect.provideService(HandlerContext, context(5_000)),
          Effect.provideService(Flusher, flusher),
        ),
      );
      yield* TestClock.adjust("100 millis");
      // Both timers are due; only the inner guard flushes.
      expect(counter.flushes).toBe(1);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(fiber)).toEqual(Exit.succeed("done"));
      expect(counter.flushes).toBe(1);
    }),
  );
});

describe("readTimeoutMargin", () => {
  it("defaults when unset, empty or unparseable", () => {
    expect(readTimeoutMargin(undefined)).toBe(DEFAULT_TIMEOUT_MARGIN_MS);
    expect(readTimeoutMargin("")).toBe(DEFAULT_TIMEOUT_MARGIN_MS);
    expect(readTimeoutMargin("abc")).toBe(DEFAULT_TIMEOUT_MARGIN_MS);
    expect(readTimeoutMargin("-1")).toBe(DEFAULT_TIMEOUT_MARGIN_MS);
  });

  it("parses whole milliseconds, 0 included", () => {
    expect(readTimeoutMargin("0")).toBe(0);
    expect(readTimeoutMargin("250")).toBe(250);
    expect(readTimeoutMargin("250.9")).toBe(250);
  });
});

describe("toTimeoutMarginMillis", () => {
  it("returns undefined for undefined", () => {
    expect(toTimeoutMarginMillis(undefined)).toBeUndefined();
  });

  it("converts a Duration to whole milliseconds", () => {
    expect(toTimeoutMarginMillis(Duration.zero)).toBe(0);
    expect(toTimeoutMarginMillis(Duration.millis(250))).toBe(250);
    expect(toTimeoutMarginMillis(Duration.seconds(1))).toBe(1000);
    expect(toTimeoutMarginMillis(Duration.infinity)).toBeUndefined();
  });

  it("converts a state-JSON rehydrated Duration", () => {
    const json = JSON.parse(
      JSON.stringify(Duration.millis(750)),
    ) as Duration.Duration;
    expect(toTimeoutMarginMillis(json)).toBe(750);
  });
});
