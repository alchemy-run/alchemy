import { createHash } from "node:crypto";
import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

const MARKER = /\s*\[alchemy ([^\]]+)\]$/;

/**
 * Ownership marker appended to a description for Log Analytics children
 * that carry no ARM tags (tables, summary rules).
 */
export const ownershipMarker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `[alchemy ${stack}/${stage}/${id}]`;
});

/** A description with the ownership marker appended. */
export const withMarker = (description: string | undefined, marker: string) =>
  description ? `${description} ${marker}` : marker;

/** A description with the Alchemy ownership marker stripped. */
export const stripMarker = (description: string | undefined) => {
  const stripped = description?.replace(MARKER, "");
  return stripped ? stripped : undefined;
};

/** Whether a description carries any Alchemy ownership marker. */
export const hasAnyMarker = (description: string | undefined) =>
  MARKER.test(description ?? "");

/**
 * A name of letters, digits, hyphens, and underscores, starting and ending
 * with a letter or digit (workspace children, query packs).
 */
export const createLogAnalyticsName = Effect.fn(function* (
  id: string,
  maxLength: number,
) {
  const name = yield* createPhysicalName({ id, maxLength });
  return name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/**
 * Whether the workspace is tagged as owned by the current stack and stage.
 * Workspace children without tags or markers inherit ownership from it.
 */
export const isWorkspaceOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
) {
  const workspace = yield* orUndefinedIfNotFound(
    operationalinsights.GetWorkspace({
      subscriptionId,
      resourceGroupName,
      workspaceName,
    }),
  );
  if (workspace === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(workspace.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Case-insensitive string equality (Azure names and enum values). */
export const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Deterministic GUID from the stack, stage, logical ID, and instance ID,
 * for resources whose name must be a GUID (query pack queries).
 */
export const deterministicGuid = Effect.fn(function* (
  id: string,
  instanceId: string,
) {
  const { stack, stage } = yield* stackAndStage;
  const hex = yield* Effect.sync(() =>
    createHash("sha256")
      .update(`${stack}/${stage}/${id}/${instanceId}`)
      .digest("hex"),
  );
  // RFC 4122 layout with version 4 / variant bits so ARM accepts it.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
});
