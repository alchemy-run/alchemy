import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { WaitBudget } from "../Arm.ts";

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
 * Deleting a customer right after its cache nodes were deleted fails until
 * ARM (`CannotDeleteResource`) and the resource provider
 * (`FailedCustomerCacheNodesExist`) catch up (eventual consistency).
 */
export const whileCacheNodesExist = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "CannotDeleteResource" ||
    e._tag === "ConnectedCacheCustomerCacheNodesExist",
  schedule: Schedule.spaced("10 seconds"),
  times: 18,
} as const;
