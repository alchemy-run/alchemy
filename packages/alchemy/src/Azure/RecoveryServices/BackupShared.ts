import * as recoveryservices from "@distilled.cloud/azure/recoveryservices";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Azure Backup keeps every Azure workload in the `Azure` fabric. */
export const BACKUP_FABRIC = "Azure";

/** Resource provider namespace of Recovery Services vaults. */
export const RECOVERY_SERVICES_NAMESPACE = "Microsoft.RecoveryServices";

/**
 * Whether the Recovery Services vault is tagged as owned by the current
 * stack and stage. Backup sub-resources carry no tags, so they inherit
 * ownership from their vault.
 */
export const isVaultOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) {
  const vault = yield* orUndefinedIfNotFound(
    recoveryservices.GetVault({ subscriptionId, resourceGroupName, vaultName }),
  );
  if (vault === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(vault.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/**
 * PATCH vault properties through the vault API, retrying while another
 * vault operation is still running. Used by the `backupconfig` /
 * `backupstorageconfig` singletons when Azure Backup reports
 * `BackupConfigManagedByVaultApi` (every vault created with current API
 * versions).
 */
export const updateVaultProperties = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  properties: recoveryservices.VaultPropertiesInput,
) =>
  recoveryservices
    .UpdateVault({ subscriptionId, resourceGroupName, vaultName, properties })
    .pipe(
      Effect.retry({
        while: (e) => e._tag === "RecoveryServicesVaultOperationInProgress",
        schedule: Schedule.spaced("10 seconds"),
        times: 18,
      }),
    );

/** Observed soft delete settings of a vault, read through the vault API. */
export const getVaultSoftDeleteSettings = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) =>
  recoveryservices
    .GetVault({ subscriptionId, resourceGroupName, vaultName })
    .pipe(
      Effect.map(
        (vault) => vault.properties?.securitySettings?.softDeleteSettings,
      ),
    );

/**
 * Deterministic name for a named backup sub-resource (policy, intent):
 * letters, digits, and hyphens, starting with a letter.
 */
export const createBackupName = Effect.fn(function* (
  id: string,
  maxLength = 60,
) {
  const name = yield* createPhysicalName({ id, maxLength, delimiter: "-" });
  return name
    .replace(/[^A-Za-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^A-Za-z]+|-+$/g, "");
});

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * Normalize a value for comparison. Azure Backup schedules only use the
 * time of day of `scheduleRunTimes`/`retentionTimes`, and the service
 * rewrites their date part, so ISO timestamps compare as `HH:MM`.
 */
const normalize = (value: unknown): unknown =>
  typeof value === "string" && ISO_DATE_TIME.test(value)
    ? value.slice(11, 16)
    : typeof value === "string"
      ? value.toLowerCase()
      : value;

/**
 * Whether every field the user set in `desired` has the same value in
 * `observed` (fields Azure fills in with defaults are ignored). Arrays must
 * match element-wise.
 */
export const matchesDesired = (
  observed: unknown,
  desired: unknown,
): boolean => {
  if (desired === undefined) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, i) => matchesDesired(observed[i], item))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      matchesDesired((observed as Record<string, unknown>)[key], value),
    );
  }
  return normalize(observed) === normalize(desired);
};

/** Case-insensitive ARM ID / name equality. */
export const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
