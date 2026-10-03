import * as signalr from "@distilled.cloud/azure/signalr";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Resource provider namespace of Azure SignalR Service. */
export const SIGNALR_NAMESPACE = "Microsoft.SignalRService";

/**
 * Deterministic name of letters, digits, and single hyphens that starts
 * with a letter and does not end with a hyphen (SignalR services, replicas,
 * shared private links, certificates, custom domains).
 */
export const createSignalRName = Effect.fn(function* (
  id: string,
  maxLength = 63,
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    lowercase: true,
    delimiter: "-",
  });
  const cleaned = name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z]+|-+$/g, "");
  return cleaned.length >= 3 ? cleaned : `sr-${cleaned}`.slice(0, maxLength);
});

export const getSignalR = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    signalr.GetSignalR({ subscriptionId, resourceGroupName, resourceName }),
  );

export const getReplica = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  replicaName: string,
) =>
  orUndefinedIfNotFound(
    signalr.GetSignalRReplicas({
      subscriptionId,
      resourceGroupName,
      resourceName,
      replicaName,
    }),
  );

/**
 * Certificates, custom domains, and shared private links carry no tags;
 * they belong to the stage that owns their SignalR service.
 */
export const signalROwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) {
  const service = yield* getSignalR(
    subscriptionId,
    resourceGroupName,
    resourceName,
  );
  if (service === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(service.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/**
 * The service runs one management operation at a time: a write that
 * arrives while the service (or a sibling child) is updating fails with a
 * conflict until the running operation finishes.
 */
export const whileSignalRBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

/** Poll budget for SignalR long-running operations (up to 10 minutes). */
export const WAIT = { interval: "10 seconds", times: 60 } as const;

export const lower = (value: string | undefined | null) =>
  value?.toLowerCase();

export const sameLocation = (
  a: string | undefined | null,
  b: string | undefined | null,
) => lower(a)?.replace(/\s/g, "") === lower(b)?.replace(/\s/g, "");

/** Azure models these booleans as the strings `"true"`/`"false"`. */
export const boolString = (value: boolean | undefined) =>
  value === undefined ? undefined : value ? "true" : "false";

/** Azure models these toggles as the strings `"Enabled"`/`"Disabled"`. */
export const enabledString = (value: boolean | undefined) =>
  value === undefined ? undefined : value ? "Enabled" : "Disabled";

/** Parent resource group, service, and child name from a child's ARM ID. */
export const parseChildId = (armId: string | undefined) => {
  const match = armId?.match(
    /\/resourceGroups\/([^/]+)\/providers\/Microsoft\.SignalRService\/signalR\/([^/]+)/i,
  );
  return match ? { resourceGroup: match[1]!, signalR: match[2]! } : undefined;
};
