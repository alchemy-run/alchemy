import * as servicenetworking from "@distilled.cloud/azure/servicenetworking";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, type WaitBudget } from "../Arm.ts";

/**
 * Generate an Application Gateway for Containers resource name: up to 64
 * letters, digits, `-`, `_`, and `.`, starting and ending with a letter or
 * digit.
 */
export const createAgcName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 64 });
  return name
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Traffic controllers and their children converge within a few minutes. */
export const AGC_BUDGET: WaitBudget = { interval: "5 seconds", times: 120 };

/** Read a traffic controller, or `undefined` when it does not exist. */
export const getTrafficController = (
  subscriptionId: string,
  resourceGroupName: string,
  trafficControllerName: string,
) =>
  orUndefinedIfNotFound(
    servicenetworking.GetTrafficControllerInterface({
      subscriptionId,
      resourceGroupName,
      trafficControllerName,
    }),
  );

/**
 * Location of a child: the explicit one, the previously observed one, or
 * the parent traffic controller's location (children must match it).
 */
export const childLocation = (
  subscriptionId: string,
  resourceGroupName: string,
  trafficControllerName: string,
  explicit: string | undefined,
  fallback: string,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return explicit;
    const parent = yield* getTrafficController(
      subscriptionId,
      resourceGroupName,
      trafficControllerName,
    );
    return parent?.location ?? fallback;
  });
