import * as vmware from "@distilled.cloud/azure/vmware";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  orUndefinedIfNotFound,
  stackAndStage,
  type WaitBudget,
} from "../Arm.ts";

/** Resource provider namespace of Azure VMware Solution. */
export const AVS_NAMESPACE = "Microsoft.AVS";

/**
 * Poll budgets. ARM runs every Microsoft.AVS PUT/DELETE as a long-running
 * operation: a private cloud takes 3-4 hours, a cluster about an hour per
 * host batch, NSX workload-network objects a few minutes.
 */
export const PRIVATE_CLOUD_BUDGET: WaitBudget = {
  interval: "240 seconds",
  times: 60,
};
export const CLUSTER_BUDGET: WaitBudget = {
  interval: "120 seconds",
  times: 60,
};
export const CHILD_BUDGET: WaitBudget = { interval: "15 seconds", times: 60 };
export const WORKLOAD_BUDGET: WaitBudget = { interval: "5 seconds", times: 60 };

/** Common props of every resource nested under a private cloud. */
export interface PrivateCloudChildProps {
  /** Resource group of the private cloud. Changing it replaces the resource. */
  resourceGroup: string;
  /** Name of the private cloud. Changing it replaces the resource. */
  privateCloud: string;
}

/**
 * Deterministic name for an AVS resource: lowercase letters, digits, and
 * single hyphens, starting and ending with a letter or digit.
 */
export const createAvsName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength, lowercase: true });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

export const getPrivateCloud = (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
) =>
  orUndefinedIfNotFound(
    vmware.GetPrivateCloud({
      subscriptionId,
      resourceGroupName,
      privateCloudName,
    }),
  );

/**
 * Whether the private cloud is tagged as owned by the current stack and
 * stage. AVS child resources cannot carry tags, so they inherit ownership
 * from their private cloud.
 */
export const isPrivateCloudOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  privateCloudName: string,
) {
  const cloud = yield* getPrivateCloud(
    subscriptionId,
    resourceGroupName,
    privateCloudName,
  );
  if (cloud === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(cloud.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Case-insensitive comparison for ARM names, groups, and IDs. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Order-insensitive comparison of string lists (undefined = empty). */
export const sameSet = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) =>
  JSON.stringify([...(a ?? [])].sort()) ===
  JSON.stringify([...(b ?? [])].sort());

/** True when the child's location props moved (parent or group changed). */
export const parentChanged = (
  news: PrivateCloudChildProps,
  output: { resourceGroup: string; privateCloud: string },
) =>
  !sameName(news.resourceGroup, output.resourceGroup) ||
  !sameName(news.privateCloud, output.privateCloud);

export const redact = (value: string | undefined) =>
  value === undefined ? undefined : Redacted.make(value);

/**
 * Salted SHA-256 fingerprint of write-only secrets, so a change can be
 * detected without persisting the secrets themselves.
 */
export const secretFingerprint = (
  salt: string,
  secrets: ReadonlyArray<Redacted.Redacted<string> | undefined>,
) =>
  secrets.every((secret) => secret === undefined)
    ? Effect.succeed(undefined)
    : Effect.sync(() =>
        Redacted.make(
          createHash("sha256")
            .update(
              `${salt}:${secrets.map((s) => (s === undefined ? "" : Redacted.value(s))).join("\u0000")}`,
            )
            .digest("hex"),
        ),
      );

export const sameFingerprint = (
  a: Redacted.Redacted<string> | undefined,
  b: Redacted.Redacted<string> | undefined,
) =>
  (a === undefined && b === undefined) ||
  (a !== undefined &&
    b !== undefined &&
    Redacted.value(a) === Redacted.value(b));

export const unredact = (value: Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.value(value);
