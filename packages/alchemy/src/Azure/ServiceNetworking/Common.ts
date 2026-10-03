import * as servicenetworking from "@distilled.cloud/azure/servicenetworking";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Schedule from "effect/Schedule";
import {
  orUndefinedIfNotFound,
  ProvisioningFailed,
  waitForProvisioned,
  type WaitBudget,
} from "../Arm.ts";

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

/**
 * Ensure a resource exists and is provisioned: PUT when it is missing or
 * in the `Failed` state, then wait for `Succeeded`. Application Gateway for
 * Containers occasionally fails a fresh child (e.g. a security policy that
 * references a just-created WAF policy); re-sending the PUT converges it.
 */
export const ensureProvisioned = <A, E, R, E2, R2>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
  stateOf: (value: A) => string | undefined,
  put: Effect.Effect<unknown, E2, R2>,
  budget: WaitBudget = AGC_BUDGET,
) =>
  Effect.gen(function* () {
    const current = yield* get;
    if (current === undefined || stateOf(current) === "Failed") {
      yield* put;
    }
    return yield* waitForProvisioned(label, get, stateOf, budget);
  }).pipe(
    Effect.retry({
      while: (e) => e instanceof ProvisioningFailed,
      schedule: Schedule.spaced("15 seconds"),
      times: 3,
    }),
  );

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
 * Wait until the parent traffic controller is `Succeeded` (children are
 * rejected or fail while it is still updating, e.g. right after another
 * child was removed) and return the child's location: the explicit one or
 * the parent's (children must match it).
 */
export const childLocation = (
  subscriptionId: string,
  resourceGroupName: string,
  trafficControllerName: string,
  explicit: string | undefined,
) =>
  Effect.gen(function* () {
    const parent = yield* waitForProvisioned(
      `traffic controller ${trafficControllerName}`,
      getTrafficController(
        subscriptionId,
        resourceGroupName,
        trafficControllerName,
      ),
      (controller) => controller.properties?.provisioningState,
      { interval: "5 seconds", times: 60 },
    );
    return explicit ?? parent.location;
  });
