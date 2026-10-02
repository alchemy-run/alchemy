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
 * @see https://learn.microsoft.com/azure/backup/backup-create-recovery-services-vault#set-storage-redundancy
 *
 * ### Storage Redundancy
 * **Example:** Locally redundant backup storage (cheapest)
 * ```typescript
 * yield* Azure.RecoveryServices.BackupStorageConfig("storage-config", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: "my-vault",
 *   storageType: "LocallyRedundant",
 * });
 * ```
 *
 * **Example:** Geo-redundant storage with Cross Region Restore
 * ```typescript
 * yield* Azure.RecoveryServices.BackupStorageConfig("storage-config", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: "my-vault",
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
      const observed = yield* backup.GetBackupResourceStorageConfigsNonCRR(
        where,
      );

      // Sync only the settings that differ (PATCH keeps the rest).
      const changed = delta(toAttrs(resourceGroup, vault, observed), news);
      if (Object.keys(changed).length === 0) {
        return toAttrs(resourceGroup, vault, observed);
      }
      yield* backup.PatchBackupResourceStorageConfigsNonCRR({
        ...where,
        properties: changed,
      });
      // The PATCH (204) applies asynchronously.
      const fresh = yield* backup.GetBackupResourceStorageConfigsNonCRR(where).pipe(
        Effect.flatMap((config) =>
          Object.keys(delta(toAttrs(resourceGroup, vault, config), news))
            .length === 0
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
                resource: `backup storage config of ${vault}`,
                state: undefined,
                message: `backup storage config of vault ${vault} did not converge after 2 minutes`,
              }),
            ),
        ),
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
      const reset = delta(current, { storageType: "GeoRedundant" });
      if (Object.keys(reset).length === 0) return;
      yield* ignoreNotFound(
        backup.PatchBackupResourceStorageConfigsNonCRR({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: output.vault,
          properties: reset,
        }),
      );
    }),

    nuke: { singleton: true },
  });
