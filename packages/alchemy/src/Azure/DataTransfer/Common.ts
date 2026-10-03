import type * as adt from "@distilled.cloud/azure/azuredatatransfer";
import { createPhysicalName } from "../../PhysicalName.ts";

/** Managed identity of an Azure Data Transfer resource. */
export interface DataTransferIdentity {
  /** Kind of managed identity to attach. */
  type:
    | "None"
    | "SystemAssigned"
    | "UserAssigned"
    | "SystemAssigned,UserAssigned";
  /** ARM IDs of user-assigned identities to attach. */
  userAssignedIdentities?: string[];
}

/** Observed managed identity of an Azure Data Transfer resource. */
export interface DataTransferObservedIdentity {
  /** Kind of managed identity attached. */
  type: string;
  /** Principal ID of the system-assigned identity, if any. */
  principalId: string | undefined;
  /** Tenant of the system-assigned identity, if any. */
  tenantId: string | undefined;
  /** ARM IDs of the attached user-assigned identities. */
  userAssignedIdentities: string[];
}

export const sameArm = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/** Resource names: 3-64 letters, digits, and `-`. */
export const createDataTransferName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 });

export const toObservedIdentity = (
  identity: adt.ApprovePipelineConnectionResponseIdentity | undefined,
): DataTransferObservedIdentity | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        principalId: identity.principalId,
        tenantId: identity.tenantId,
        userAssignedIdentities: Object.keys(
          identity.userAssignedIdentities ?? {},
        ),
      };

export const toIdentityInput = (
  identity: DataTransferIdentity | undefined,
): adt.ConnectionsCreateOrUpdateRequestIdentity | undefined =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities === undefined ||
          identity.userAssignedIdentities.length === 0
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
      };

/**
 * Whether the observed identity differs from the desired one. An omitted
 * desired identity is left unmanaged.
 */
export const identityDiffers = (
  observed: adt.ApprovePipelineConnectionResponseIdentity | undefined,
  desired: DataTransferIdentity | undefined,
) => {
  if (desired === undefined) return false;
  const have = toObservedIdentity(observed);
  const haveType = have?.type ?? "None";
  if (!sameArm(haveType, desired.type)) return true;
  const want = (desired.userAssignedIdentities ?? []).map((id) =>
    id.toLowerCase(),
  );
  const got = (have?.userAssignedIdentities ?? []).map((id) =>
    id.toLowerCase(),
  );
  return want.length !== got.length || want.some((id) => !got.includes(id));
};

/** Order-insensitive equality of two optional string lists. */
export const sameList = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) => {
  const left = [...(a ?? [])].map((s) => s.toLowerCase()).sort();
  const right = [...(b ?? [])].map((s) => s.toLowerCase()).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};
