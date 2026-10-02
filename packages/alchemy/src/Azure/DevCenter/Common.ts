import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/**
 * Generate a Dev Center resource name: letters, digits, and hyphens,
 * starting with a letter or digit. Dev centers are capped at 26 characters
 * (the name is part of the `{name}-{region}.devcenter.azure.com` endpoint);
 * other Dev Center resources allow 63.
 */
export const createDevCenterName = Effect.fn(function* (
  id: string,
  maxLength = 63,
) {
  const name = yield* createPhysicalName({
    id,
    maxLength,
    lowercase: true,
  });
  return name.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
});

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined && v !== null)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
};

/**
 * Structural equality ignoring key order and `undefined`/`null` members,
 * for comparing desired nested settings against what ARM returns.
 */
export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Whether every defined key of `desired` matches `observed`. */
export const containsValue = (
  observed: object | undefined | null,
  desired: object,
) =>
  Object.entries(desired).every(
    ([key, value]) =>
      value === undefined ||
      sameValue((observed as Record<string, unknown> | undefined)?.[key], value),
  );

export type DevCenterIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned";

/** Managed identity of a dev center, project, or project environment type. */
export interface DevCenterIdentity {
  /** Identity type. */
  type: DevCenterIdentityType;
  /**
   * ARM resource IDs of user-assigned identities. Required when `type`
   * includes `UserAssigned`.
   */
  userAssignedIdentities?: string[];
}

export const toIdentityInput = (
  identity: DevCenterIdentity | undefined,
): devcenter.DevCentersCreateOrUpdateRequestIdentity | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities: identity.userAssignedIdentities?.length
          ? Object.fromEntries(
              identity.userAssignedIdentities.map((id) => [id, {}]),
            )
          : undefined,
      };

/** Whether the observed identity differs from the desired one. */
export const identityDiffers = (
  observed:
    | {
        readonly type?: string;
        readonly userAssignedIdentities?: Record<string, unknown>;
      }
    | undefined,
  desired: DevCenterIdentity | undefined,
) => {
  if (desired === undefined) return false;
  const norm = (type: string | undefined) =>
    (type ?? "None").replace(/\s+/g, "").toLowerCase();
  if (norm(observed?.type) !== norm(desired.type)) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return have.join("\n") !== want.join("\n");
};

/** Observe a dev center; `undefined` when it does not exist. */
export const getDevCenter = (
  subscriptionId: string,
  resourceGroupName: string,
  devCenterName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetDevCenter({ subscriptionId, resourceGroupName, devCenterName }),
  );

/** Observe a project; `undefined` when it does not exist. */
export const getProject = (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetProject({ subscriptionId, resourceGroupName, projectName }),
  );

const ownedByStage = Effect.fn(function* (
  tags: Record<string, string | undefined> | undefined,
) {
  const { stack, stage } = yield* stackAndStage;
  return tags?.["alchemy::stack"] === stack && tags?.["alchemy::stage"] === stage;
});

/**
 * Children of a dev center without tags (attached networks, galleries,
 * project policies) count as owned when the dev center carries this
 * stack's and stage's ownership tags.
 */
export const devCenterOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  devCenterName: string,
) {
  const observed = yield* getDevCenter(
    subscriptionId,
    resourceGroupName,
    devCenterName,
  );
  return yield* ownedByStage(observed?.tags);
});

/** Same as {@link devCenterOwnedByStage} for children of a project. */
export const projectOwnedByStage = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  projectName: string,
) {
  const observed = yield* getProject(
    subscriptionId,
    resourceGroupName,
    projectName,
  );
  return yield* ownedByStage(observed?.tags);
});
