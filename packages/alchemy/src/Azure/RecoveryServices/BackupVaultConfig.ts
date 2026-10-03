import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  isVaultOwnedByStack,
  RECOVERY_SERVICES_NAMESPACE,
} from "./BackupShared.ts";

export type SoftDeleteFeatureState = "Enabled" | "Disabled" | "AlwaysON";

export interface BackupVaultConfigProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the config. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the config. */
  vault: string;
  /**
   * Soft delete of backup data. `Disabled` lets deleted protected items be
   * purged immediately (and the vault be deleted right away); `AlwaysON`
   * is irreversible.
   * @default unmanaged
   */
  softDeleteFeatureState?: SoftDeleteFeatureState;
  /**
   * Days soft-deleted backup data is retained (14-180).
   * @default unmanaged
   */
  softDeleteRetentionPeriodInDays?: number;
  /**
   * Enhanced security (extra protection for destructive operations).
   * @default unmanaged
   */
  enhancedSecurityState?: "Enabled" | "Disabled";
}

export interface BackupVaultConfig extends Resource<
  "Azure.RecoveryServices.BackupVaultConfig",
  BackupVaultConfigProps,
  {
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the config (`.../backupconfig/vaultconfig`). */
    vaultConfigId: string;
    /** Observed soft delete state. */
    softDeleteFeatureState: string;
    /** Observed soft delete retention in days. */
    softDeleteRetentionPeriodInDays: number | undefined;
    /** Observed enhanced security state. */
    enhancedSecurityState: string;
    /** Observed backup storage redundancy. */
    storageType: string;
    /** `Locked` once an item has been protected (storage type is then fixed). */
    storageTypeState: string;
  },
  never,
  Providers
> {}

/**
 * The backup settings of a Recovery Services vault
 * (`backupconfig/vaultconfig`): soft delete and enhanced security.
 *
 * This is a singleton: every vault has exactly one. Only the settings you
 * specify are managed. Destroying the resource restores Azure's defaults
 * for those settings (soft delete `Enabled`, 14 days, enhanced security
 * `Enabled`) unless soft delete was set to the irreversible `AlwaysON`.
 *
 * Vaults created with current API versions start with soft delete
 * `AlwaysON` set through the vault API; Azure Backup then rejects changes
 * through this API with the typed `BackupConfigManagedByVaultApi` error.
 * Manage soft delete on such vaults with {@link Vault}; settings that
 * already match converge without a write.
 *
 * @see https://learn.microsoft.com/azure/backup/backup-azure-security-feature-cloud
 *
 * ### Soft Delete
 * **Example:** Disable soft delete on a test vault
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("backup-vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.RecoveryServices.BackupVaultConfig("vault-config", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   softDeleteFeatureState: "Disabled",
 * });
 * ```
 *
 * **Example:** Keep soft-deleted backups for 30 days
 * ```typescript
 * yield* Azure.RecoveryServices.BackupVaultConfig("vault-config", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   softDeleteFeatureState: "Enabled",
 *   softDeleteRetentionPeriodInDays: 30,
 * });
 * ```
 *
 * @resource
 */
export const BackupVaultConfig = Resource<BackupVaultConfig>(
  "Azure.RecoveryServices.BackupVaultConfig",
);

type Observed = backup.GetBackupResourceVaultConfigResponse;

const getConfig = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) =>
  orUndefinedIfNotFound(
    backup.GetBackupResourceVaultConfig({
      subscriptionId,
      resourceGroupName,
      vaultName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  vault: string,
  observed: Observed,
): BackupVaultConfig["Attributes"] => {
  const props = observed.properties ?? {};
  return {
    vault,
    resourceGroup,
    vaultConfigId: observed.id ?? "",
    softDeleteFeatureState: props.softDeleteFeatureState ?? "",
    softDeleteRetentionPeriodInDays: props.softDeleteRetentionPeriodInDays,
    enhancedSecurityState: props.enhancedSecurityState ?? "",
    storageType: props.storageType ?? "",
    storageTypeState: props.storageTypeState ?? "",
  };
};

const same = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

/** The delta between observed and desired settings. */
const delta = (
  observed: BackupVaultConfig["Attributes"],
  news: Partial<BackupVaultConfigProps>,
): backup.BackupResourceVaultConfig => {
  const changed: backup.BackupResourceVaultConfig = {};
  if (
    news.softDeleteFeatureState !== undefined &&
    !same(observed.softDeleteFeatureState, news.softDeleteFeatureState)
  ) {
    changed.softDeleteFeatureState = news.softDeleteFeatureState;
  }
  if (
    news.softDeleteRetentionPeriodInDays !== undefined &&
    observed.softDeleteRetentionPeriodInDays !==
      news.softDeleteRetentionPeriodInDays
  ) {
    changed.softDeleteRetentionPeriodInDays =
      news.softDeleteRetentionPeriodInDays;
  }
  if (
    news.enhancedSecurityState !== undefined &&
    !same(observed.enhancedSecurityState, news.enhancedSecurityState)
  ) {
    changed.enhancedSecurityState = news.enhancedSecurityState;
  }
  return changed;
};

const patchConfig = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  properties: backup.BackupResourceVaultConfig,
) =>
  backup.UpdateBackupResourceVaultConfig({
    subscriptionId,
    resourceGroupName,
    vaultName,
    properties,
  });

export const BackupVaultConfigProvider = () =>
  Provider.succeed(BackupVaultConfig, {
    stables: ["vault", "resourceGroup", "vaultConfigId"],

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
      const observed = yield* backup.GetBackupResourceVaultConfig(where);

      // Sync only the settings that differ.
      const changed = delta(toAttrs(resourceGroup, vault, observed), news);
      if (Object.keys(changed).length === 0) {
        return toAttrs(resourceGroup, vault, observed);
      }
      yield* patchConfig(subscriptionId, resourceGroup, vault, changed);
      const fresh = yield* backup.GetBackupResourceVaultConfig(where);
      return toAttrs(resourceGroup, vault, fresh);
    }),

    // Restore Azure's defaults for the managed settings; a missing vault
    // means there is nothing left to reset. `AlwaysON` cannot be undone.
    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const observed = yield* getConfig(
        subscriptionId,
        output.resourceGroup,
        output.vault,
      );
      if (observed === undefined) return;
      const current = toAttrs(output.resourceGroup, output.vault, observed);
      const alwaysOn = same(current.softDeleteFeatureState, "AlwaysON");
      const reset = delta(current, {
        softDeleteFeatureState:
          olds?.softDeleteFeatureState !== undefined && !alwaysOn
            ? "Enabled"
            : undefined,
        softDeleteRetentionPeriodInDays:
          olds?.softDeleteRetentionPeriodInDays !== undefined && !alwaysOn
            ? 14
            : undefined,
        enhancedSecurityState:
          olds?.enhancedSecurityState !== undefined ? "Enabled" : undefined,
      });
      if (Object.keys(reset).length === 0) return;
      yield* ignoreNotFound(
        patchConfig(subscriptionId, output.resourceGroup, output.vault, reset),
      );
    }),

    nuke: { singleton: true },
  });
