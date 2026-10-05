import type * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { WaitBudget } from "../Arm.ts";
import { stackAndStage } from "../Arm.ts";

/**
 * Generate a Cognitive Services account name: lowercase letters, digits,
 * and hyphens, starting and ending with a letter or digit. It is also the
 * default `customSubDomainName`, which must be a valid, globally unique
 * DNS label (64 characters is rejected), so it is capped at 48.
 */
export const createAccountName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 48,
    lowercase: true,
  });
  return name.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
});

/**
 * Generate an account child name (project, connection, RAI policy, ...):
 * letters, digits, `-`, and `_`, starting and ending with a letter or
 * digit.
 */
export const createChildName = Effect.fn(function* (
  id: string,
  maxLength = 64,
) {
  const name = yield* createPhysicalName({ id, maxLength });
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
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

/** Whether every key of `desired` matches `observed` (extra observed keys ignored). */
export const containsValue = (
  observed: Record<string, unknown> | undefined | null,
  desired: Record<string, unknown>,
) =>
  Object.entries(desired).every(
    ([key, value]) => value === undefined || sameValue(observed?.[key], value),
  );

export type CognitiveServicesIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned";

export interface CognitiveServicesIdentity {
  /** Identity type. */
  type: CognitiveServicesIdentityType;
  /**
   * ARM resource IDs of user-assigned identities. Required when `type`
   * includes `UserAssigned`.
   */
  userAssignedIdentities?: string[];
}

export const toIdentityInput = (
  identity: CognitiveServicesIdentity | undefined,
): cognitiveservices.IdentityInput | undefined =>
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
  observed: cognitiveservices.Identity | undefined,
  desired: CognitiveServicesIdentity | undefined,
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

/**
 * Ownership markers for resources without tags (connections carry them in
 * `metadata`).
 */
export const ownershipMarkers = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return {
    "alchemy::stack": stack,
    "alchemy::stage": stage,
    "alchemy::id": id,
  };
});

/** Strip Alchemy ownership markers from a map. */
export const withoutMarkers = (
  map: Record<string, string | undefined> | undefined | null,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] =>
        !entry[0].startsWith("alchemy::") && entry[1] !== undefined,
    ),
  );

/** Account-scoped children converge in seconds. */
export const CHILD_BUDGET: WaitBudget = { interval: "3 seconds", times: 40 };

/** Accounts, projects, and capability hosts take up to a few minutes. */
export const ACCOUNT_BUDGET: WaitBudget = { interval: "5 seconds", times: 72 };

/**
 * An account injected into a Microsoft-managed network provisions the
 * managed VNet and agent subnet with it: creates measured 5-7+ minutes,
 * deletes ~22-28 minutes.
 */
export const MANAGED_NETWORK_ACCOUNT_BUDGET: WaitBudget = {
  interval: "30 seconds",
  times: 90,
};

/**
 * The account rejects a write while another write to it or one of its
 * children (projects, RAI policies, blocklists, ...) is still in progress.
 */
export const whileAccountBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "CognitiveServicesRequestConflict" ||
    e._tag === "ResourceConflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 24,
} as const;
