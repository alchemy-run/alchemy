import * as storage from "@distilled.cloud/azure/storage";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { createInternalTags, hasAlchemyTags, tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/**
 * Storage child resources (containers, shares, queues) carry no ARM tags.
 * Their metadata keys must be C# identifiers, so the `alchemy::*`
 * ownership tags are stored as `alchemy_*` metadata.
 */
const toMetadataKey = (key: string) => key.replace(/^alchemy::/, "alchemy_");
const toTagKey = (key: string) => key.replace(/^alchemy_/, "alchemy::");

/** Ownership markers (`alchemy_stack`, `alchemy_stage`, `alchemy_id`). */
export const ownershipMetadata = Effect.fn(function* (id: string) {
  const tags = yield* createInternalTags(id);
  return Object.fromEntries(
    Object.entries(tags).map(([key, value]) => [toMetadataKey(key), value]),
  );
});

/** User metadata with the ownership markers stripped. */
export const userMetadata = (
  metadata: Record<string, string | undefined> | undefined,
) =>
  Object.fromEntries(
    Object.entries(tagRecord(metadata)).filter(
      ([key]) => !key.startsWith("alchemy_"),
    ),
  );

/** Whether metadata carries this stack/stage/id's ownership markers. */
export const isOwnedByMetadata = (
  id: string,
  metadata: Record<string, string | undefined> | undefined,
) =>
  hasAlchemyTags(
    id,
    Object.fromEntries(
      Object.entries(tagRecord(metadata)).map(([key, value]) => [
        toTagKey(key),
        value,
      ]),
    ),
  );

/**
 * Deterministic name for a storage child: 3-63 lowercase letters, digits,
 * and single hyphens, starting and ending with a letter or digit.
 */
export const createStorageChildName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 63,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

/**
 * Whether the storage account is tagged as owned by the current stack and
 * stage. Children and settings that cannot carry tags or metadata inherit
 * ownership from their account.
 */
export const isAccountOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) {
  const account = yield* orUndefinedIfNotFound(
    storage.GetStorageAccountProperties({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );
  if (account === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(account.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** A stored access policy on a file share or table. */
export interface StorageAccessPolicy {
  /** Unique identifier of the policy (up to 64 characters). */
  id: string;
  /** Abbreviated permissions, e.g. `"r"`, `"rw"`, `"raud"`. */
  permission: string;
  /** ISO 8601 start time of the policy. */
  startTime?: string;
  /** ISO 8601 expiry time of the policy. */
  expiryTime?: string;
}

const instant = (value: string | undefined) =>
  value === undefined ? undefined : new Date(value).getTime();

/**
 * Normalize stored access policies for comparison: Azure rewrites
 * timestamps (e.g. adds fractional seconds), so times compare as instants.
 */
const normalizePolicies = (
  policies: ReadonlyArray<{
    id?: string;
    accessPolicy?: {
      permission?: string;
      startTime?: string;
      expiryTime?: string;
    };
  }>,
) =>
  JSON.stringify(
    policies
      .map((policy) => ({
        id: policy.id ?? "",
        permission: [...(policy.accessPolicy?.permission ?? "")]
          .sort()
          .join(""),
        start: instant(policy.accessPolicy?.startTime),
        expiry: instant(policy.accessPolicy?.expiryTime),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

/** The wire shape of stored access policies. */
export const toSignedIdentifiers = (
  policies: ReadonlyArray<StorageAccessPolicy>,
) =>
  policies.map((policy) => ({
    id: policy.id,
    accessPolicy: {
      permission: policy.permission,
      startTime: policy.startTime,
      expiryTime: policy.expiryTime,
    },
  }));

/** The attribute shape of observed stored access policies. */
export const fromSignedIdentifiers = (
  observed:
    | ReadonlyArray<{
        id?: string;
        accessPolicy?: {
          permission?: string;
          startTime?: string;
          expiryTime?: string;
        };
      }>
    | undefined,
): StorageAccessPolicy[] =>
  (observed ?? []).map((policy) => ({
    id: policy.id ?? "",
    permission: policy.accessPolicy?.permission ?? "",
    startTime: policy.accessPolicy?.startTime,
    expiryTime: policy.accessPolicy?.expiryTime,
  }));

/** Whether observed stored access policies differ from the desired ones. */
export const accessPoliciesDiffer = (
  observed:
    | ReadonlyArray<{
        id?: string;
        accessPolicy?: {
          permission?: string;
          startTime?: string;
          expiryTime?: string;
        };
      }>
    | undefined,
  desired: ReadonlyArray<StorageAccessPolicy>,
) =>
  normalizePolicies(observed ?? []) !==
  normalizePolicies(toSignedIdentifiers(desired));
