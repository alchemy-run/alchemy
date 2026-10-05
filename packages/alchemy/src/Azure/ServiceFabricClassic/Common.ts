import * as servicefabric from "@distilled.cloud/azure/servicefabric";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";

/** Observe a classic Service Fabric cluster; `undefined` when missing. */
export const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    servicefabric.GetCluster({ subscriptionId, resourceGroupName, clusterName }),
  );

/** Every classic cluster in the subscription (children are listed per cluster). */
export const listClusters = Effect.gen(function* () {
  const { subscriptionId } = yield* AzureEnvironment.current;
  const page = yield* servicefabric
    .ListClusters({ subscriptionId })
    .pipe(Effect.flatMap((page) => requireSinglePage("ListClusters", page)));
  return (page.value ?? []).flatMap((cluster) => {
    const resourceGroup = resourceGroupOf(cluster.id);
    return resourceGroup !== undefined && cluster.name !== undefined
      ? [{ resourceGroup, clusterName: cluster.name }]
      : [];
  });
});

/**
 * Cluster name: 4-23 lowercase letters, digits, and hyphens. The instance
 * suffix is shortened so the stack-name prefix (a letter) survives.
 */
export const createClusterName = (id: string) =>
  createPhysicalName({ id, maxLength: 23, lowercase: true, suffixLength: 8 });

/** Name for an application type, application, or service. */
export const createEntityName = (id: string) =>
  createPhysicalName({ id, maxLength: 60 });

export const lower = (value: string | undefined) =>
  value?.toLowerCase().replace(/\s/g, "");

/**
 * Whether `desired` is already reflected in `observed`. Objects match when
 * every desired key matches (the service fills in defaults for omitted
 * keys); arrays match element-wise with equal length; scalars compare
 * case-insensitively for strings.
 */
export const matches = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((item, i) => matches(item, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    const record = observed as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(
      ([key, value]) => matches(value, record[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

/**
 * The subset of `desired` whose keys are set and differ from `observed`,
 * or `undefined` when nothing differs.
 */
export const delta = <T extends object>(
  desired: T,
  observed: object | undefined,
): Partial<T> | undefined => {
  const record = (observed ?? {}) as Record<string, unknown>;
  const changed = Object.fromEntries(
    Object.entries(desired).filter(
      ([key, value]) => value !== undefined && !matches(value, record[key]),
    ),
  ) as Partial<T>;
  return Object.keys(changed).length > 0 ? changed : undefined;
};
