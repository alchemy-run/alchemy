import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export const makeSubscriptionCleanup = () => {
  let deadline: number | undefined;
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      deadline ??= now + 20_000;
      const remaining = deadline - now;
      if (remaining <= 0) {
        return yield* Effect.die(
          new Error("Subscription cleanup deadline exceeded"),
        );
      }
      return yield* effect.pipe(Effect.timeout(Math.min(5_000, remaining)));
    }).pipe(Effect.orDie, Effect.interruptible);
};
