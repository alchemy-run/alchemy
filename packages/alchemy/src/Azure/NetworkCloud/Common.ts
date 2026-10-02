import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createPhysicalName } from "../../PhysicalName.ts";
import { type WaitBudget, waitForProvisioned } from "../Arm.ts";
import type { NexusIdentity } from "./Types.ts";

/** Resource provider namespace of Azure Operator Nexus. */
export const NEXUS_NAMESPACE = "Microsoft.NetworkCloud";

/**
 * Generate a Nexus resource name: letters, digits, and `-`, starting and
 * ending with a letter or digit. Most types allow 64 characters; Kubernetes
 * clusters, agent pools, and virtual machines are capped lower by the RP.
 */
export const createNexusName = Effect.fn(function* (
  id: string,
  maxLength = 63,
) {
  const name = yield* createPhysicalName({ id, maxLength });
  return name.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
});

/** ARM names, IDs, and locations compare case-insensitively. */
export const sameArm = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** The `extendedLocation` body for a custom location ARM ID. */
export const customLocation = (id: string) => ({
  name: id,
  type: "CustomLocation" as const,
});

/**
 * Nexus workload objects (networks, volumes, key sets) converge within a
 * few minutes once the on-premises cluster acknowledges them.
 */
export const NEXUS_BUDGET: WaitBudget = { interval: "10 seconds", times: 60 };

/**
 * Cluster managers, clusters, Kubernetes clusters, agent pools, and
 * virtual machines take tens of minutes.
 */
export const NEXUS_SLOW_BUDGET: WaitBudget = {
  interval: "30 seconds",
  times: 60,
};

/** Poll a Nexus GET until `properties.provisioningState` succeeds. */
export const waitNexusProvisioned = <
  A extends { readonly properties?: { readonly provisioningState?: string } },
  E,
  R,
>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
  budget: WaitBudget = NEXUS_BUDGET,
) =>
  waitForProvisioned(
    label,
    get,
    (value) => value.properties?.provisioningState,
    budget,
  );

/**
 * Whether `observed` already carries everything in `desired`. Objects are
 * compared by the keys `desired` sets (the service adds defaults and
 * read-only fields), arrays element by element, and strings
 * case-insensitively (ARM IDs and enum values come back re-cased).
 */
export const inSync = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((value, index) => inSync(observed[index], value))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    if (Array.isArray(observed)) return false;
    const record = observed as Record<string, unknown>;
    return Object.entries(desired).every(([key, value]) =>
      inSync(record[key], value),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return observed === desired;
};

/**
 * The desired fields that differ from the observed properties, or
 * `undefined` when everything is in sync. Fields left `undefined` in
 * `desired` are not managed and never produce a delta.
 */
export const propertyDelta = <T extends object>(
  observed: object | undefined,
  desired: T,
): T | undefined => {
  const record = (observed ?? {}) as Record<string, unknown>;
  const delta: Partial<T> = {};
  let changed = false;
  for (const key of Object.keys(desired) as (keyof T & string)[]) {
    const value = desired[key];
    if (value !== undefined && !inSync(record[key], value)) {
      delta[key] = value;
      changed = true;
    }
  }
  return changed ? (delta as T) : undefined;
};

/** Order- and case-sensitive structural inequality of two prop values. */
export const differs = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);

const unredact = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return Redacted.value(value);
  if (Array.isArray(value)) return value.map(unredact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, unredact(inner)]),
    );
  }
  return value;
};

/**
 * Inequality of two prop values that may carry `Redacted` secrets. Azure
 * never returns secrets, so secret-bearing props are compared against the
 * previous props instead of observed state.
 */
export const secretsDiffer = (a: unknown, b: unknown) =>
  differs(unredact(a), unredact(b));

/** The ARM identity body for a {@link NexusIdentity}. */
export const identityBody = (identity: NexusIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentityIds === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentityIds.map((id) => [id, {}]),
              ),
      };

/** Whether the observed identity matches the desired one. */
export const identityInSync = (
  observed:
    | {
        readonly type?: string;
        readonly userAssignedIdentities?: { readonly [key: string]: unknown };
      }
    | undefined,
  desired: NexusIdentity | undefined,
) => {
  if (desired === undefined) return true;
  if (!sameArm(observed?.type ?? "None", desired.type)) return false;
  const want = (desired.userAssignedIdentityIds ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return JSON.stringify(want) === JSON.stringify(have);
};
