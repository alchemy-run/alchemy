import { expect } from "@alchemy.run/test";
import type { ScratchStack } from "@alchemy.run/test/Alchemy";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";

/**
 * Starts `stack.destroy()` and interrupts it once the cloud reports the
 * resource as `deleting`. That is what a destroy cancelled mid-wait leaves
 * behind: a delete the cloud is still running, on a resource the stack still
 * holds in state. The next `stack.destroy()` has to finish that delete, and
 * many delete APIs reject a second call for as long as the first runs.
 *
 * `status` reads the resource's status out-of-band. It is polled every
 * `spaced` (2 seconds by default), at most `times` times (30 by default); a
 * destroy that fails or finishes before the status shows up fails the test.
 */
export const interruptDestroy = Effect.fn(function* <E, R>(
  stack: ScratchStack,
  options: {
    status: Effect.Effect<string | undefined, E, R>;
    deleting: string;
    spaced?: Duration.Input;
    times?: number;
  },
) {
  const destroying = yield* stack.destroy().pipe(Effect.forkChild);
  const observed = yield* Effect.raceFirst(
    options.status.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(options.spaced ?? "2 seconds"),
        times: options.times ?? 30,
        until: (status) => status === options.deleting,
      }),
    ),
    Fiber.join(destroying).pipe(Effect.as("destroy finished first")),
  );
  expect(observed).toBe(options.deleting);
  yield* Fiber.interrupt(destroying);
  // Still deleting, so the next destroy meets a delete already under way.
  expect(yield* options.status).toBe(options.deleting);
});
