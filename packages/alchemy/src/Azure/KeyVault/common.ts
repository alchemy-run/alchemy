import * as keyvault from "@distilled.cloud/azure/keyvault";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/**
 * Generate a name valid for vaults and managed HSMs: 3-24 lowercase
 * letters and digits, starting with a letter (hyphens are allowed by Azure
 * but never consecutively, so they are dropped).
 */
export const createVaultName = Effect.fn(function* (id: string) {
  const name = (yield* createPhysicalName({
    id,
    maxLength: 24,
    lowercase: true,
    delimiter: "",
  })).replace(/[^a-z0-9]/g, "");
  return /^[a-z]/.test(name) ? name : `v${name}`.slice(0, 24);
});

/** Generate a key or secret name: 1-127 letters, digits, and hyphens. */
export const createObjectName = (id: string) =>
  createPhysicalName({ id, maxLength: 127, delimiter: "-" }).pipe(
    Effect.map((name) => name.replace(/[^a-zA-Z0-9-]/g, "-")),
  );

/**
 * Generate a managed HSM key name. The service rejects names longer than 89
 * characters (observed), despite the documented 127.
 */
export const createManagedHsmKeyName = (id: string) =>
  createPhysicalName({ id, maxLength: 89, delimiter: "-" }).pipe(
    Effect.map((name) => name.replace(/[^a-zA-Z0-9-]/g, "-")),
  );

export const getVault = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) =>
  orUndefinedIfNotFound(
    keyvault.GetVault({ subscriptionId, resourceGroupName, vaultName }),
  );

export const getDeletedVault = (
  subscriptionId: string,
  location: string,
  vaultName: string,
) =>
  orUndefinedIfNotFound(
    keyvault.GetVaultDeleted({ subscriptionId, location, vaultName }),
  );

/**
 * Whether a vault carries Alchemy ownership tags for the current stack and
 * stage (any logical ID). Used by vault children that cannot be tagged.
 */
export const isVaultOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) {
  const vault = yield* getVault(subscriptionId, resourceGroupName, vaultName);
  if (vault === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  return (
    vault.tags?.["alchemy::stack"] === stack &&
    vault.tags?.["alchemy::stage"] === stage
  );
});

/** Same as {@link isVaultOwnedByStack} for a managed HSM. */
export const isManagedHsmOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) {
  const hsm = yield* orUndefinedIfNotFound(
    keyvault.GetManagedHsm({ subscriptionId, resourceGroupName, name }),
  );
  if (hsm === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  return (
    hsm.tags?.["alchemy::stack"] === stack &&
    hsm.tags?.["alchemy::stage"] === stage
  );
});

export const lower = (value: string | undefined) => value?.toLowerCase();

export const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
