import * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

export const lower = (value: string | undefined) => value?.toLowerCase();

export const sameId = (a: string | undefined, b: string | undefined) =>
  lower(a) === lower(b);

/**
 * Generate a name for Kusto child resources (databases, principal
 * assignments, scripts, data connections, ...): letters, digits, and
 * hyphens.
 */
export const createKustoChildName = Effect.fn(function* (
  id: string,
  maxLength = 64,
) {
  const name = yield* createPhysicalName({ id, maxLength });
  return name.replace(/[^A-Za-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
});

export const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    kusto.GetCluster({ subscriptionId, resourceGroupName, clusterName }),
  );

/**
 * Whether the Kusto cluster is tagged as owned by the current stack and
 * stage. Cluster children cannot carry tags or markers, so they inherit
 * ownership from their cluster.
 */
export const isClusterOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) {
  const cluster = yield* getCluster(
    subscriptionId,
    resourceGroupName,
    clusterName,
  );
  if (cluster === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(cluster.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Location of the cluster, the default location of its children. */
export const clusterLocation = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) {
  const cluster = yield* getCluster(
    subscriptionId,
    resourceGroupName,
    clusterName,
  );
  return cluster?.location;
});

/**
 * A cluster runs one management operation at a time; a write while it is
 * `Updating` (e.g. a sibling child being created) fails with a conflict.
 */
export const whileClusterBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "ResourceConflict" || e._tag === "Conflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;
