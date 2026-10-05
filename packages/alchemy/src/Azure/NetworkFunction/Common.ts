import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { WaitBudget } from "../Arm.ts";

/**
 * Generate a Traffic Collector / collector policy name: 1-80 letters,
 * digits, `_`, `.`, and `-`, starting and ending with a letter or digit.
 */
export const createNetworkFunctionName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 80 });
  return name
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Collectors and policies take 5-10 minutes to provision and delete. */
export const COLLECTOR_BUDGET: WaitBudget = {
  interval: "10 seconds",
  times: 90,
};

/**
 * Retry a collector write while a previous operation on the collector is
 * still running (Azure asks to "retry again in 10 minutes"); bounded to
 * ~15 minutes.
 */
export const retryWhileCollectorBusy = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "TrafficCollectorOperationInProgress",
      schedule: Schedule.spaced("30 seconds"),
      times: 30,
    }),
  );
