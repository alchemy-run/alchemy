import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import * as Effect from "effect/Effect";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Resource provider namespace of Backup vaults and resource guards. */
export const NAMESPACE = "Microsoft.DataProtection";

export const getVault = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) =>
  orUndefinedIfNotFound(
    dataprotection.GetBackupVault({
      subscriptionId,
      resourceGroupName,
      vaultName,
    }),
  );

/**
 * Whether the Backup vault is tagged as owned by the current stack and
 * stage. Vault children that cannot carry tags (policies, resource guard
 * proxies) inherit ownership from their vault.
 */
export const isVaultOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) {
  const vault = yield* getVault(subscriptionId, resourceGroupName, vaultName);
  if (vault === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(vault.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Case-insensitive string equality (ARM names, locations, IDs). */
export const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * Whether every field of `desired` is present and equal in `observed`.
 * Azure echoes rules back with defaulted fields filled in, so a subset
 * comparison avoids re-sending an unchanged policy. Strings compare
 * case-insensitively.
 */
export const isSubset = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => isSubset(value, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      isSubset(value, (observed as Record<string, unknown>)[key]),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};
