import * as Effect from "effect/Effect";
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
