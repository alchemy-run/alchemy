import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { WaitBudget } from "../Arm.ts";

/**
 * Generate a DNS Private Resolver child/top-level name: 1-80 letters,
 * digits, `_`, and `-`, starting and ending with a letter or digit.
 */
export const createDnsResolverName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 80 });
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Order-insensitive, case-insensitive comparison of ARM ID lists. */
export const sameArmIds = (
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
) => {
  const norm = (ids: ReadonlyArray<string>) =>
    [...new Set(ids.map((id) => id.toLowerCase()))].sort().join("\n");
  return norm(a) === norm(b);
};

/** Endpoints and resolvers take a few minutes to provision and delete. */
export const ENDPOINT_BUDGET: WaitBudget = { interval: "5 seconds", times: 96 };

/** Rulesets, links, policies, and domain lists converge in seconds. */
export const FAST_BUDGET: WaitBudget = { interval: "3 seconds", times: 60 };

/**
 * Deleting a parent right after its nested children were deleted fails
 * with `CannotDeleteResource` until ARM catches up (eventual consistency).
 */
export const whileNestedResourcesExist = {
  while: (e: { readonly _tag: string }) => e._tag === "CannotDeleteResource",
  schedule: Schedule.spaced("10 seconds"),
  times: 18,
} as const;
