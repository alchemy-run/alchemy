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
 * `AlwaysON` set through the vault API, and Azure Backup rejects changes
 * through the legacy `backupconfig` API for them; Alchemy then applies the
 * change through the vault API instead. Leaving `AlwaysON` is impossible
 * and fails with the typed `BackupConfigManagedByVaultApi` error, but the
 * retention period stays editable. Settings that already match converge
 * without a write.
 *
 * @see https://learn.microsoft.com/azure/backup/backup-azure-security-feature-cloud
 *
 * ### Soft Delete
 * **Example:** Keep soft-deleted backups for 30 days
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("backup-vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.RecoveryServices.BackupVaultConfig("vault-config", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   softDeleteRetentionPeriodInDays: 30,
 * });
 * ```
 *
 * **Example:** Disable soft delete on a vault that is not `AlwaysON`
 * ```typescript
 * yield* Azure.RecoveryServices.BackupVaultConfig("vault-config", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: legacyVaultName,
 *   softDeleteFeatureState: "Disabled",
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

/**
 * Apply `changed` through the legacy `backupconfig` API, or through the
 * vault API when Azure Backup reports the vault's soft delete is managed
 * there (every vault created with current API versions). `AlwaysON` states
 * are irreversible, so changing one keeps the original typed error.
 */
const applyChange = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  current: BackupVaultConfig["Attributes"],
  changed: backup.BackupResourceVaultConfig,
) =>
  backup
    .UpdateBackupResourceVaultConfig({
      subscriptionId,
      resourceGroupName,
      vaultName,
      properties: changed,
    })
    .pipe(
      Effect.asVoid,
      Effect.catchTag("BackupConfigManagedByVaultApi", (error) =>
        (changed.softDeleteFeatureState !== undefined &&
          same(current.softDeleteFeatureState, "AlwaysON")) ||
        (changed.enhancedSecurityState !== undefined &&
          same(current.enhancedSecurityState, "AlwaysON"))
          ? Effect.fail(error)
          : updateVaultProperties(subscriptionId, resourceGroupName, vaultName, {
              securitySettings: {
                softDeleteSettings: {
                  softDeleteState:
                    changed.softDeleteFeatureState ??
                    current.softDeleteFeatureState,
                  softDeleteRetentionPeriodInDays:
                    changed.softDeleteRetentionPeriodInDays ??
                    current.softDeleteRetentionPeriodInDays,
                  enhancedSecurityState:
                    changed.enhancedSecurityState ??
                    current.enhancedSecurityState,
                },
              },
            }).pipe(Effect.asVoid),
      ),
    );

/** The vault API applies changes asynchronously; poll until they show. */
const waitConverged = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  desired: Partial<BackupVaultConfigProps>,
) =>
  backup
    .GetBackupResourceVaultConfig({
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
              resource: `backup vault config of ${vaultName}`,
              state: undefined,
              message: `backup vault config of vault ${vaultName} did not converge after 2 minutes`,
            }),
          ),
      ),
    );

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

    // Restore Azure's defaults for the managed settings; a missing vault
    // means there is nothing left to reset. `AlwaysON` states cannot be
    // undone, but the retention period of an `AlwaysON` vault can.
    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const observed = yield* getConfig(
        subscriptionId,
        output.resourceGroup,
        output.vault,
      );
      if (observed === undefined) return;
      const current = toAttrs(output.resourceGroup, output.vault, observed);
      const desired: Partial<BackupVaultConfigProps> = {
        softDeleteFeatureState:
          olds?.softDeleteFeatureState !== undefined &&
          !same(current.softDeleteFeatureState, "AlwaysON")
            ? "Enabled"
            : undefined,
        softDeleteRetentionPeriodInDays:
          olds?.softDeleteRetentionPeriodInDays !== undefined ? 14 : undefined,
        enhancedSecurityState:
          olds?.enhancedSecurityState !== undefined &&
          !same(current.enhancedSecurityState, "AlwaysON")
            ? "Enabled"
            : undefined,
      };
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
