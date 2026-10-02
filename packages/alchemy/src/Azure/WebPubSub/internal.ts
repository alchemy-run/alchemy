import * as webpubsub from "@distilled.cloud/azure/webpubsub";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Resource provider namespace of Azure Web PubSub (shared with SignalR). */
export const WEBPUBSUB_NAMESPACE = "Microsoft.SignalRService";

/**
 * Deterministic name of letters, digits, and single hyphens that starts
 * with a letter and does not end with a hyphen (Web PubSub services,
 * replicas, shared private links, certificates, custom domains).
 */
export const createWebPubSubName = Effect.fn(function* (
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
  return cleaned.length >= 3 ? cleaned : `wps-${cleaned}`.slice(0, maxLength);
});

/**
 * Deterministic hub name: letters, digits, and underscores, starting with a
 * letter.
 */
export const createHubName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 100,
    delimiter: "_",
  });
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]+/, "");
  return cleaned.length > 0 ? cleaned : "hub";
});

export const getWebPubSub = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    webpubsub.GetWebPubSub({ subscriptionId, resourceGroupName, resourceName }),
  );

/**
 * Hubs, shared private links, certificates, and custom domains carry no
 * tags; they belong to the stage that owns their Web PubSub service.
 */
export const webPubSubOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) {
  const service = yield* getWebPubSub(
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
export const whileWebPubSubBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "ResourceConflict" || e._tag === "Conflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

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
