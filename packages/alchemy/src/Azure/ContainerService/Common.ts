import * as cs from "@distilled.cloud/azure/containerservice";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Read a managed cluster, or `undefined` when missing. */
export const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetManagedCluster({ subscriptionId, resourceGroupName, resourceName }),
  );

/** Read a fleet, or `undefined` when missing. */
export const getFleet = (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetFleet({ subscriptionId, resourceGroupName, fleetName }),
  );

const ownedByStack = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return (
    tags?.["alchemy::stack"] === stack && tags?.["alchemy::stage"] === stage
  );
});

/**
 * Whether the parent cluster belongs to the current stack and stage. Cluster
 * children without tags inherit ownership from the cluster.
 */
export const isClusterOwned = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) {
  const cluster = yield* getCluster(
    subscriptionId,
    resourceGroupName,
    clusterName,
  );
  return yield* ownedByStack(cluster?.tags);
});

/**
 * Whether the parent fleet belongs to the current stack and stage. Fleet
 * children without tags inherit ownership from the fleet.
 */
export const isFleetOwned = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
) {
  const fleet = yield* getFleet(subscriptionId, resourceGroupName, fleetName);
  return yield* ownedByStack(fleet?.tags);
});

/** Case-insensitive comparison for Azure names, IDs, and locations. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * Deterministic child name: lowercase letters, digits, and hyphens,
 * starting with a letter.
 */
export const createChildName = Effect.fn(function* (
  id: string,
  maxLength: number,
  delimiter = "-",
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    lowercase: true,
    delimiter,
  });
  const cleaned = name.replace(
    delimiter === "" ? /[^a-z0-9]/g : /[^a-z0-9-]/g,
    "",
  );
  return /^[a-z]/.test(cleaned)
    ? cleaned
    : `a${cleaned.slice(0, maxLength - 1)}`;
});

/**
 * Whether every value set in `desired` is present in `observed`. AKS fills
 * in defaults on GET, so desired state is compared as a subset; arrays must
 * match element by element.
 */
export const subsetMatches = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((item, index) => subsetMatches(item, observed[index]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      subsetMatches(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

/**
 * AKS serializes operations on a cluster: a write while another operation
 * (e.g. an agent pool create) runs fails with `OperationNotAllowed` /
 * `AnotherOperationInProgress` (409). Wait and retry.
 */
export const whileClusterBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "OperationNotAllowed" || e._tag === "NetworkOperationInProgress",
  schedule: Schedule.spaced("15 seconds"),
  times: 40,
} as const;

/**
 * Cluster creation is additionally throttled per subscription ("Too soon
 * to create another managed cluster. Please retry after 35 seconds"),
 * e.g. while a create-before-delete replacement provisions its successor.
 */
export const whileClusterCreateBlocked = {
  while: (e: { readonly _tag: string }) =>
    whileClusterBusy.while(e) || e._tag === "RequestRateLimitExceeded",
  schedule: Schedule.spaced("15 seconds"),
  times: 40,
} as const;

/**
 * Fleet writes conflict with an in-flight fleet operation (409), and a
 * fleet cannot be deleted while members are still leaving it; both clear
 * on their own.
 */
export const whileFleetBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "OperationNotAllowed" ||
    e._tag === "ResourceConflict" ||
    e._tag === "NetworkOperationInProgress",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Overlay the defined values of `patch` onto an observed ARM model, merging
 * nested objects (arrays and scalars are replaced). Used to build a full
 * PUT body from a GET response plus the desired deltas.
 */
export const deepMerge = <T>(base: unknown, patch: unknown): T => {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return (patch === undefined ? base : patch) as T;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = deepMerge(base[key], value);
  }
  return merged as T;
};
