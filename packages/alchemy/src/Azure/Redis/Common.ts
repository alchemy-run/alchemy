import * as redisenterprise from "@distilled.cloud/azure/redisenterprise";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/**
 * Cluster name: letters, digits, and single hyphens. Azure caps the name
 * plus the location's display name (e.g. `East US`) at 62 characters, so
 * generated names stop at 40.
 */
export const createClusterName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 40,
    lowercase: true,
    delimiter: "-",
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
});

export const getCluster = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) =>
  orUndefinedIfNotFound(
    redisenterprise.GetRedisEnterprise({
      subscriptionId,
      resourceGroupName,
      clusterName,
    }),
  );

export const getDatabase = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
) =>
  orUndefinedIfNotFound(
    redisenterprise.GetDatabase({
      subscriptionId,
      resourceGroupName,
      clusterName,
      databaseName,
    }),
  );

/**
 * Databases and access policy assignments have no tags; they belong to the
 * stage that owns their cluster.
 */
export const clusterOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
) {
  const observed = yield* getCluster(
    subscriptionId,
    resourceGroupName,
    clusterName,
  );
  const { stack, stage } = yield* stackAndStage;
  return (
    observed?.tags?.["alchemy::stack"] === stack &&
    observed?.tags?.["alchemy::stage"] === stage
  );
});

const FAILED_RESOURCE_STATES = new Set([
  "CreateFailed",
  "UpdateFailed",
  "DeleteFailed",
  "EnableFailed",
  "DisableFailed",
  "ScalingFailed",
]);

/**
 * Readiness of a cluster or database: ARM reports `provisioningState:
 * Succeeded` before the Redis data plane is `Running`, so both must settle.
 * Mapped onto the `waitForProvisioned` vocabulary.
 */
export const readiness = (value: {
  properties?: { provisioningState?: string; resourceState?: string };
}) => {
  const provisioning = value.properties?.provisioningState;
  if (provisioning !== undefined && provisioning !== "Succeeded") {
    return provisioning;
  }
  const resource = value.properties?.resourceState;
  if (resource === undefined || resource === "Running") return "Succeeded";
  if (FAILED_RESOURCE_STATES.has(resource)) return "Failed";
  return resource;
};

export const lower = (value: string | undefined) => value?.toLowerCase();
