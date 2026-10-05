import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  ProvisioningTimedOut,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  isVaultOwnedByStack,
  RECOVERY_SERVICES_NAMESPACE,
  updateVaultProperties,
} from "./BackupShared.ts";

export type BackupStorageType =
  | "LocallyRedundant"
  | "GeoRedundant"
  | "ZoneRedundant";

export interface BackupStorageConfigProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the config. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the config. */
  vault: string;
  /**
   * Redundancy of backup storage. Can only be changed while
   * `storageTypeState` is `Unlocked`, i.e. before the first item is
   * protected in the vault.
   * @default unmanaged
   */
  storageType?: BackupStorageType;
  /**
   * Cross Region Restore (restore in the paired region). Requires
   * `GeoRedundant` storage and cannot be disabled once enabled.
   * @default unmanaged
   */
  crossRegionRestoreFlag?: boolean;
}

export interface BackupStorageConfig extends Resource<
  "Azure.RecoveryServices.BackupStorageConfig",
  BackupStorageConfigProps,
  {
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the config (`.../backupstorageconfig/vaultstorageconfig`). */
    storageConfigId: string;
    /** Observed storage redundancy. */
    storageType: string;
    /** `Locked` once an item has been protected (storage type is then fixed). */
    storageTypeState: string;
    /** Observed Cross Region Restore flag. */
    crossRegionRestoreFlag: boolean;
  },
  never,
  Providers
> {}

/**
 * The backup storage settings of a Recovery Services vault
 * (`backupstorageconfig/vaultstorageconfig`): storage redundancy and
 * Cross Region Restore.
 *
 * This is a singleton: every vault has exactly one. Only the settings you
 * specify are managed. Configure it before protecting anything — once an
 * item is protected the storage type is locked. Destroying the resource
 * restores the default `GeoRedundant` storage type while it is still
 * unlocked; Cross Region Restore cannot be turned off.
 *
 * Vaults created with current API versions get their redundancy set
 * through the vault API, and Azure Backup rejects changes through the
 * legacy `backupstorageconfig` API for them; Alchemy then applies the
 * change through the vault API instead. Settings that already match
 * converge without a write.
 *
 * @see https://learn.microsoft.com/azure/backup/backup-create-recovery-services-vault#set-storage-redundancy
 *
 * ### Storage Redundancy
 * **Example:** Locally redundant backup storage (cheapest)
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("backup-vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.RecoveryServices.BackupStorageConfig("storage-config", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   storageType: "LocallyRedundant",
 * });
 * ```
 *
 * **Example:** Geo-redundant storage with Cross Region Restore
 * ```typescript
 * yield* Azure.RecoveryServices.BackupStorageConfig("storage-config", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   storageType: "GeoRedundant",
 *   crossRegionRestoreFlag: true,
 * });
 * ```
 *
 * @resource
 */
export const BackupStorageConfig = Resource<BackupStorageConfig>(
  "Azure.RecoveryServices.BackupStorageConfig",
);

type Observed = backup.GetBackupResourceStorageConfigsNonCRRResponse;

const getConfig = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) =>
  orUndefinedIfNotFound(
    backup.GetBackupResourceStorageConfigsNonCRR({
      subscriptionId,
      resourceGroupName,
      vaultName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  vault: string,
  observed: Observed,
): BackupStorageConfig["Attributes"] => {
  const props = observed.properties ?? {};
  return {
    vault,
    resourceGroup,
    storageConfigId: observed.id ?? "",
    storageType: props.storageType ?? props.storageModelType ?? "",
    storageTypeState: props.storageTypeState ?? "",
    crossRegionRestoreFlag: props.crossRegionRestoreFlag ?? false,
  };
};

const same = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

/** The delta between observed and desired settings. */
const delta = (
  observed: BackupStorageConfig["Attributes"],
  news: Partial<BackupStorageConfigProps>,
): backup.BackupResourceConfig => {
  const changed: backup.BackupResourceConfig = {};
  if (
    news.storageType !== undefined &&
    !same(observed.storageType, news.storageType)
  ) {
    // The service reads `storageModelType`; `storageType` is its legacy alias.
    changed.storageModelType = news.storageType;
    changed.storageType = news.storageType;
  }
  if (
    news.crossRegionRestoreFlag !== undefined &&
    observed.crossRegionRestoreFlag !== news.crossRegionRestoreFlag
  ) {
    changed.crossRegionRestoreFlag = news.crossRegionRestoreFlag;
  }
  return changed;
};

/**
 * Apply `changed` through the legacy `backupstorageconfig` API, or through
 * the vault API when Azure Backup reports the vault's redundancy is managed
 * there (every vault created with current API versions).
 */
const applyChange = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  current: BackupStorageConfig["Attributes"],
  changed: backup.BackupResourceConfig,
) =>
  backup
    .PatchBackupResourceStorageConfigsNonCRR({
      subscriptionId,
      resourceGroupName,
      vaultName,
      properties: changed,
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("BackupConfigManagedByVaultApi", () =>
        updateVaultProperties(subscriptionId, resourceGroupName, vaultName, {
          // ARM rejects redundancy settings that omit either field.
          redundancySettings: {
            standardTierStorageRedundancy:
              changed.storageType ?? current.storageType,
            crossRegionRestore:
              (changed.crossRegionRestoreFlag ?? current.crossRegionRestoreFlag)
                ? "Enabled"
                : "Disabled",
          },
        }).pipe(Effect.asVoid),
      ),
    );

/** Both APIs apply the change asynchronously; poll until it shows. */
const waitConverged = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  desired: Partial<BackupStorageConfigProps>,
) =>
  backup
    .GetBackupResourceStorageConfigsNonCRR({
      subscriptionId,
      resourceGroupName,
      vaultName,
    })
    .pipe(
      Effect.flatMap((config) =>
        Object.keys(
          delta(toAttrs(resourceGroupName, vaultName, config), desired),
        ).length === 0
          ? Effect.succeed(config)
          : Effect.fail("pending" as const),
      ),
      Effect.retry({
        while: (e) => e === "pending",
        schedule: Schedule.spaced("5 seconds"),
        times: 24,
      }),
      Effect.catchIf(
        (e): e is "pending" => e === "pending",
        () =>
          Effect.fail(
            new ProvisioningTimedOut({
              resource: `backup storage config of ${vaultName}`,
              state: undefined,
              message: `backup storage config of vault ${vaultName} did not converge after 2 minutes`,
            }),
          ),
      ),
    );

export const BackupStorageConfigProvider = () =>
  Provider.succeed(BackupStorageConfig, {
    stables: ["vault", "resourceGroup", "storageConfigId"],

    // A per-vault singleton that disappears with its vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.vault.toLowerCase() !== output.vault.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const observed = yield* getConfig(subscriptionId, resourceGroup, vault);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vault, observed);
      return output !== undefined ||
        (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, RECOVERY_SERVICES_NAMESPACE);
      const { resourceGroup, vault } = news;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: vault,
      };

      // Observe. The config always exists alongside its vault.
      const observed =
        yield* backup.GetBackupResourceStorageConfigsNonCRR(where);

      // Sync only the settings that differ (PATCH keeps the rest).
      const current = toAttrs(resourceGroup, vault, observed);
      const changed = delta(current, news);
      if (Object.keys(changed).length === 0) return current;
      yield* applyChange(subscriptionId, resourceGroup, vault, current, changed);
      const fresh = yield* waitConverged(
        subscriptionId,
        resourceGroup,
        vault,
        news,
      );
      return toAttrs(resourceGroup, vault, fresh);
    }),

    // Restore the default storage type while it can still change; a
    // missing vault means there is nothing left to reset.
    delete: Effect.fn(function* ({ olds, output }) {
      if (olds?.storageType === undefined) return;
      const { subscriptionId } = yield* AzureEnvironment.current;
      const observed = yield* getConfig(
        subscriptionId,
        output.resourceGroup,
        output.vault,
      );
      if (observed === undefined) return;
      const current = toAttrs(output.resourceGroup, output.vault, observed);
      if (!same(current.storageTypeState, "Unlocked")) return;
      const desired = { storageType: "GeoRedundant" } as const;
      const reset = delta(current, desired);
      if (Object.keys(reset).length === 0) return;
      yield* ignoreNotFound(
        applyChange(
          subscriptionId,
          output.resourceGroup,
          output.vault,
          current,
          reset,
        ).pipe(
          Effect.andThen(
            waitConverged(
              subscriptionId,
              output.resourceGroup,
              output.vault,
              desired,
            ),
          ),
        ),
      );
    }),

    nuke: { singleton: true },
  });
