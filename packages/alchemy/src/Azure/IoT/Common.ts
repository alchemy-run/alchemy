import * as dps from "@distilled.cloud/azure/deviceprovisioningservices";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Observe a provisioning service; `undefined` when it does not exist. */
export const getProvisioningService = (
  subscriptionId: string,
  resourceGroupName: string,
  provisioningServiceName: string,
) =>
  orUndefinedIfNotFound(
    dps.GetIotDpsResource({
      subscriptionId,
      resourceGroupName,
      provisioningServiceName,
    }),
  );

/**
 * Children of a provisioning service (certificates, private endpoint
 * connections) carry no tags. They count as owned when their parent service
 * carries this stack's and stage's ownership tags.
 */
export const provisioningServiceOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  provisioningServiceName: string,
) {
  const observed = yield* getProvisioningService(
    subscriptionId,
    resourceGroupName,
    provisioningServiceName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

/**
 * Globally unique provisioning service name
 * (`{name}.azure-devices-provisioning.net`): 3-50 letters, digits, and
 * hyphens, not starting or ending with a hyphen.
 */
export const createProvisioningServiceName = Effect.fn(function* (id: string) {
  return (yield* createPhysicalName({ id, maxLength: 50, lowercase: true }))
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

/**
 * Certificate name: letters, digits, periods, hyphens, and underscores,
 * starting and ending with a letter or digit.
 */
export const createCertificateName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 64 });
  return name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/** Case- and whitespace-insensitive comparison of ARM names and IDs. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase().replace(/\s/g, "") === b?.toLowerCase().replace(/\s/g, "");

/**
 * Retry a write while the service is still applying a previous change
 * (`IotDpsStateTransitioning`, e.g. right after a private endpoint
 * connection is approved or rejected).
 */
export const retryWhileTransitioning = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "IotDpsStateTransitioning",
      schedule: Schedule.spaced("5 seconds"),
      times: 36,
    }),
  );
