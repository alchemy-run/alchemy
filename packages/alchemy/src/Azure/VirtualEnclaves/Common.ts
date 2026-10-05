import * as mission from "@distilled.cloud/azure/mission";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { type WaitBudget, orUndefinedIfNotFound } from "../Arm.ts";
import type { VirtualEnclavesIdentityType } from "./Types.ts";

export const NAMESPACE = "Microsoft.Mission";

/** Communities and enclaves deploy firewalls, hubs and VNets: 30-60+ minutes. */
export const SLOW: WaitBudget = { interval: "30 seconds", times: 150 };
/** Endpoints, workloads and connections program firewall rules. */
export const FAST: WaitBudget = { interval: "10 seconds", times: 90 };

export const lower = (value: string | undefined) => value?.toLowerCase();

/** Case-insensitive equality of optional names, IDs and locations. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  lower(a)?.replace(/\s/g, "") === lower(b)?.replace(/\s/g, "");

/** Last segment of an ARM resource ID. */
export const lastSegment = (armId: string | undefined) =>
  armId?.split("/").filter(Boolean).at(-1);

/**
 * Name for a Microsoft.Mission resource: letters, digits and hyphens,
 * starting with a letter and ending with a letter or digit, 3-30 characters.
 */
export const createMissionName = Effect.fn(function* (
  id: string,
  maxLength = 30,
) {
  const name = (yield* createPhysicalName({ id, maxLength, lowercase: true }))
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
  return /^[a-z]/.test(name) ? name : `m${name.slice(1)}`;
});

/**
 * True when every value set in `desired` equals the observed value
 * (recursively, strings case-insensitively). Keys left `undefined` in
 * `desired` are not compared.
 */
export const matchesObserved = (
  desired: unknown,
  observed: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => matchesObserved(value, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      matchesObserved(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

/**
 * The subset of `desired` whose keys differ from `observed`; `undefined`
 * when nothing differs.
 */
export const changedProperties = <T extends object>(
  desired: T,
  observed: object | undefined,
): Partial<T> | undefined => {
  const changed = Object.fromEntries(
    Object.entries(desired).filter(
      ([key, value]) =>
        !matchesObserved(value, (observed as Record<string, unknown>)?.[key]),
    ),
  ) as Partial<T>;
  return Object.keys(changed).length > 0 ? changed : undefined;
};

/** Managed identity request body from `identityType` + user-assigned IDs. */
export const toIdentity = (
  type: VirtualEnclavesIdentityType | undefined,
  userAssignedIdentityIds: string[] | undefined,
) =>
  type === undefined
    ? undefined
    : {
        type,
        userAssignedIdentities: userAssignedIdentityIds?.length
          ? Object.fromEntries(userAssignedIdentityIds.map((id) => [id, {}]))
          : undefined,
      };

/** True when the observed identity differs from the desired identity. */
export const identityDiffers = (
  desired: ReturnType<typeof toIdentity>,
  observed:
    | { type?: string; userAssignedIdentities?: Record<string, unknown> }
    | undefined,
) => {
  if (desired === undefined) return false;
  if (!sameName(desired.type, observed?.type ?? "None")) return true;
  const want = Object.keys(desired.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return want.join(",") !== have.join(",");
};

/** Observe a community; `undefined` when it does not exist. */
export const getCommunity = (
  subscriptionId: string,
  resourceGroupName: string,
  communityName: string,
) =>
  orUndefinedIfNotFound(
    mission.GetCommunity({ subscriptionId, resourceGroupName, communityName }),
  );

/** Observe a virtual enclave; `undefined` when it does not exist. */
export const getVirtualEnclave = (
  subscriptionId: string,
  resourceGroupName: string,
  virtualEnclaveName: string,
) =>
  orUndefinedIfNotFound(
    mission.GetVirtualEnclave({
      subscriptionId,
      resourceGroupName,
      virtualEnclaveName,
    }),
  );
