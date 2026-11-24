import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

/**
 * Runs `deploy` on the test clock, moving it 10 seconds at a time until the
 * deploy finishes.
 */
export const onTestClock = <A, E, R>(deploy: Effect.Effect<A, E, R>, clock = { steps: 0 }) =>
  Effect.gen(function* () {
    const fiber = yield* deploy.pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
    yield* TestClock.withLive(Effect.sleep("5 millis")).pipe(
      Effect.andThen(TestClock.adjust("10 seconds")),
      Effect.andThen(
        Effect.sync(() => {
          clock.steps++;
        }),
      ),
      Effect.repeat({ until: () => fiber.pollUnsafe() !== undefined, times: 200 }),
    );
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer()));
