import * as storagesync from "@distilled.cloud/azure/storagesync";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/*
 * Shared, un-exported helpers for the StorageSync resources. Not
 * re-exported from `index.ts`.
 */

export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/**
 * Name for a Storage Sync child (sync group, cloud/server endpoint):
 * letters, digits, `-`, `_`, `.`; starts and ends with a letter or digit.
 */
export const createChildName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength, lowercase: true });
  return name
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
});

/**
 * Whether the Storage Sync Service is tagged as owned by the current stack
 * and stage. Sync groups, endpoints, and private endpoint connections carry
 * no tags, so they inherit ownership from their service.
 */
export const isServiceOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  storageSyncServiceName: string,
) {
  const service = yield* orUndefinedIfNotFound(
    storagesync.GetStorageSyncService({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
    }),
  );
  if (service === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(service.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});
