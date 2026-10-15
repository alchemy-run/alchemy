import * as Effect from "effect/Effect";

export const dispatchMaximumCount = 10_000;
export const dispatchObjectName = "steady";

const step = Effect.fn("dispatch.primitive")(function* (value: number) {
  return yield* Effect.succeed(value + 1);
});

/** Same bounded primitive/span workload in the Worker and Durable Object. */
export const dispatchLoop = (count: number) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(count) || count < 0 || count > dispatchMaximumCount) {
      return yield* Effect.die(new Error(`count must be between 0 and ${dispatchMaximumCount}`));
    }
    let checksum = 0;
    for (let index = 0; index < count; index++) checksum += yield* step(index);
    return checksum;
  });
