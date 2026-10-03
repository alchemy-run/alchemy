import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import type { WaitBudget } from "../Arm.ts";

/** Resource provider namespace of Azure Operator Service Manager. */
export const NAMESPACE = "Microsoft.HybridNetwork";

/**
 * Generate an AOSM resource name: 1-64 letters, digits, `_`, and `-`,
 * starting with a letter or digit.
 */
export const createHybridNetworkName = Effect.fn(function* (
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

/** Canonical JSON (sorted keys) for comparing documents and JSON strings. */
export const canonical = (value: unknown): string => {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sort(value)) ?? "undefined";
};

/** Compare two JSON strings semantically (whitespace and key order ignored). */
export const sameJson = (a: string | undefined, b: string | undefined) => {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return canonical(JSON.parse(a)) === canonical(JSON.parse(b));
  } catch {
    return false;
  }
};

/** AOSM metadata resources converge in well under a minute. */
export const FAST_BUDGET: WaitBudget = { interval: "3 seconds", times: 80 };

/**
 * Artifact stores provision a managed resource group with a container
 * registry or storage account; creation and deletion take several minutes.
 */
export const STORE_BUDGET: WaitBudget = { interval: "10 seconds", times: 90 };

/**
 * AOSM rejects a write with `HybridNetworkOperationInProgress` while the
 * previous asynchronous operation on the resource is still settling, which
 * can outlast the moment GET first reports `Succeeded`.
 */
export const retryInProgress = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.retry(effect, {
    while: (e) => e._tag === "HybridNetworkOperationInProgress",
    schedule: Schedule.spaced("5 seconds"),
    times: 36,
  });

export type HybridNetworkIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface HybridNetworkIdentity {
  /** Kind of managed identity attached to the resource. */
  type: HybridNetworkIdentityType;
  /**
   * ARM IDs of user-assigned managed identities (for `UserAssigned` and
   * `SystemAssigned,UserAssigned`).
   */
  userAssignedIdentities?: string[];
}

/** ARM request body for a managed identity. */
export const identityRequest = (identity: HybridNetworkIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
      };

/** Whether the observed identity differs from the desired one. */
export const identityDiffers = (
  observed:
    | {
        readonly type: string;
        readonly userAssignedIdentities?: Record<string, unknown> | null;
      }
    | undefined,
  desired: HybridNetworkIdentity | undefined,
) => {
  if (desired === undefined) return false;
  if ((observed?.type ?? "None") !== desired.type) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((k) => k.toLowerCase())
    .sort()
    .join("\n");
  const want = (desired.userAssignedIdentities ?? [])
    .map((k) => k.toLowerCase())
    .sort()
    .join("\n");
  return have !== want;
};

/** Order- and case-insensitive comparison of `{ name: armId }` maps. */
export const sameIdMap = (
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined,
) => {
  const norm = (m: Record<string, string> | undefined) =>
    Object.entries(m ?? {})
      .map(([k, v]) => `${k}=${v.toLowerCase()}`)
      .sort()
      .join("\n");
  return norm(a) === norm(b);
};
