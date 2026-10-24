import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { DeleteTimedOut, type WaitBudget, waitUntilGone } from "../Arm.ts";

/**
 * Generate a Connected Cache resource name: letters, digits, and `-`,
 * starting and ending with a letter or digit, at most 50 characters.
 */
export const createConnectedCacheName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 50 });
  return name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/** ARM names and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Connected Cache customers and cache nodes converge within a minute or two. */
export const MCC_BUDGET: WaitBudget = { interval: "5 seconds", times: 60 };

/**
 * Delete, then wait until gone; re-send the DELETE when the resource is
 * still there. The ISP resource provider accepts (HTTP 202) but drops a
 * DELETE sent while the create is still `Accepted`.
 */
export const deleteUntilGone = <E1, R1, A, E2, R2>(
  resource: string,
  remove: Effect.Effect<void, E1, R1>,
  get: Effect.Effect<A | undefined, E2, R2>,
) =>
  remove.pipe(
    Effect.andThen(waitUntilGone(resource, get, { interval: "5 seconds", times: 12 })),
    Effect.retry({
      while: (e) => e instanceof DeleteTimedOut,
      times: 4,
    }),
  );

/**
 * Deleting a customer right after its cache nodes were deleted fails until
 * ARM (`CannotDeleteResource`) and the resource provider
 * (`FailedCustomerCacheNodesExist`) catch up (eventual consistency).
 */
export const whileCacheNodesExist = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "CannotDeleteResource" || e._tag === "ConnectedCacheCustomerCacheNodesExist",
  schedule: Schedule.spaced("10 seconds"),
  times: 18,
} as const;
