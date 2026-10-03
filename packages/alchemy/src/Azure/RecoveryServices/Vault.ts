import * as recoveryservices from "@distilled.cloud/azure/recoveryservices";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type VaultIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned, UserAssigned";

export interface VaultIdentity {
  /** Managed identity type. `None` removes all identities. */
  type: VaultIdentityType;
  /**
   * ARM resource IDs of user-assigned identities attached to the vault.
   * Required when `type` includes `UserAssigned`.
   */
  userAssignedIdentities?: string[];
}

export type VaultStorageRedundancy =
  | "LocallyRedundant"
  | "GeoRedundant"
  | "ZoneRedundant";

export type VaultAlertsState = "Enabled" | "Disabled";

export interface VaultMonitoringSettings {
  /** Built-in Azure Monitor alerts for all backup job failures. */
  alertsForAllJobFailures?: VaultAlertsState;
  /** Built-in Azure Monitor alerts for all Site Recovery replication issues. */
  alertsForAllReplicationIssues?: VaultAlertsState;
  /** Built-in Azure Monitor alerts for all Site Recovery failover issues. */
  alertsForAllFailoverIssues?: VaultAlertsState;
  /** Classic (legacy) alerts for critical operations. */
  classicAlertsForCriticalOperations?: VaultAlertsState;
  /** Classic e-mail notifications for Site Recovery. */
  emailNotificationsForSiteRecovery?: VaultAlertsState;
}

export interface VaultEncryption {
  /** Key Vault key URI of the customer-managed key. */
  keyUri: string;
  /**
   * ARM resource ID of the user-assigned identity used to access the key.
   * If omitted, the vault's system-assigned identity is used.
   */
  userAssignedIdentity?: string;
  /**
   * Double encryption with platform-managed keys. Can only be set once.
   * @default "Disabled"
   */
  infrastructureEncryption?: "Enabled" | "Disabled";
}

export interface VaultProps {
  /**
   * Resource group the vault is created in. Changing it replaces the vault.
   */
  resourceGroup: string;
  /**
   * Vault name: 2-50 letters, digits, and hyphens, starting with a letter.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the vault.
   */
  name?: string;
  /**
   * Azure location of the vault. Changing it replaces the vault.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Managed identity of the vault. */
  identity?: VaultIdentity;
  /**
   * Whether the vault accepts traffic from public networks.
   * @default "Enabled"
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Backup storage redundancy. Azure only allows changing it until the
   * first item is protected.
   * @default Azure's default ("GeoRedundant")
   */
  storageRedundancy?: VaultStorageRedundancy;
  /**
   * Cross Region Restore for geo-redundant vaults. Once items are
   * protected it can be enabled but not disabled.
   */
  crossRegionRestore?: "Enabled" | "Disabled";
  /**
   * Restoring backups into other subscriptions. `PermanentlyDisabled` is
   * irreversible.
   */
  crossSubscriptionRestore?: "Enabled" | "Disabled" | "PermanentlyDisabled";
  /**
   * Days a soft-deleted backup item is retained (14-180). New vaults have
   * the irreversible `AlwaysON` soft delete; only the retention period can
   * change.
   * @default 14
   */
  softDeleteRetentionPeriodInDays?: number;
  /**
   * Immutability of recovery points. `Locked` is irreversible.
   */
  immutability?: "Disabled" | "Unlocked" | "Locked";
  /** Alert and notification settings. */
  monitoringSettings?: VaultMonitoringSettings;
  /** Customer-managed-key encryption of backup data. */
  encryption?: VaultEncryption;
  /** Resource tags. */
  tags?: Record<string, string>;
}

export interface Vault extends Resource<
  "Azure.RecoveryServices.Vault",
  VaultProps,
  {
    /** Name of the vault. */
    vaultName: string;
    /** ARM resource ID of the vault. */
    vaultId: string;
    /** Resource group that holds the vault. */
    resourceGroup: string;
    /** Location of the vault. */
    location: string;
    /** Managed identity type of the vault, if any. */
    identityType: string | undefined;
    /**
     * Object ID of the vault's system-assigned identity. Grant it access to
     * a Key Vault key for customer-managed-key encryption.
     */
    principalId: string | undefined;
    /** Microsoft Entra tenant of the vault's identity. */
    tenantId: string | undefined;
    /** Whether public network access is enabled. */
    publicNetworkAccess: string | undefined;
    /** Backup storage redundancy. */
    storageRedundancy: string | undefined;
    /** Cross Region Restore state. */
    crossRegionRestore: string | undefined;
    /** Soft-delete state for backup items. */
    softDeleteState: string | undefined;
    /** Immutability state. */
    immutabilityState: string | undefined;
    /** Backup storage version (`V1` / `V2`). */
    backupStorageVersion: string | undefined;
    /** Secure score of the vault. */
    secureScore: string | undefined;
    /** BCDR security level of the vault. */
    bcdrSecurityLevel: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Recovery Services vault — the container for Azure Backup
 * policies, protected items, and Site Recovery replication. An empty vault
 * is free; you pay for protected instances and backup storage.
 *
 * @see https://learn.microsoft.com/azure/backup/backup-azure-recovery-services-vault-overview
 *
 * ### Creating a Vault
 * **Example:** Basic vault
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("backup");
 * const vault = yield* Azure.RecoveryServices.Vault("vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Locally redundant vault with a system-assigned identity
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   storageRedundancy: "LocallyRedundant",
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * ### Security Settings
 * **Example:** Soft-delete retention and immutability
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   softDeleteRetentionPeriodInDays: 30,
 *   immutability: "Unlocked",
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * ### Backing Up Resources
 * **Example:** Vault with a backup policy
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const policy = yield* Azure.RecoveryServices.BackupPolicy("files-daily", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   backupManagementType: "AzureStorage",
 *   workLoadType: "AzureFileShare",
 *   schedulePolicy: {
 *     schedulePolicyType: "SimpleSchedulePolicy",
 *     scheduleRunFrequency: "Daily",
 *     scheduleRunTimes: ["2026-01-01T23:00:00Z"],
 *   },
 *   retentionPolicy: {
 *     retentionPolicyType: "SimpleRetentionPolicy",
 *     retentionDuration: { count: 7, durationType: "Days" },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Vault = Resource<Vault>("Azure.RecoveryServices.Vault");

type ObservedVault = recoveryservices.GetVaultResponse;

const createVaultName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 50,
    delimiter: "-",
  });
  const cleaned = name.replace(/[^A-Za-z0-9-]/g, "-");
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `v${cleaned.slice(0, 49)}`;
});

const getVault = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
) =>
  orUndefinedIfNotFound(
    recoveryservices.GetVault({ subscriptionId, resourceGroupName, vaultName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  vault: ObservedVault,
): Vault["Attributes"] => {
  const props = vault.properties;
  return {
    vaultName: name,
    vaultId: vault.id ?? "",
    resourceGroup,
    location: vault.location,
    identityType: vault.identity?.type,
    principalId: vault.identity?.principalId,
    tenantId: vault.identity?.tenantId,
    publicNetworkAccess: props?.publicNetworkAccess,
    storageRedundancy: props?.redundancySettings?.standardTierStorageRedundancy,
    crossRegionRestore: props?.redundancySettings?.crossRegionRestore,
    softDeleteState:
      props?.securitySettings?.softDeleteSettings?.softDeleteState,
    immutabilityState: props?.securitySettings?.immutabilitySettings?.state,
    backupStorageVersion: props?.backupStorageVersion,
    secureScore: props?.secureScore,
    bcdrSecurityLevel: props?.bcdrSecurityLevel,
    tags: userTags(vault.tags),
  };
};

const lower = (value: string | undefined) => value?.toLowerCase();

const normalizeType = (type: string | undefined) =>
  (type ?? "None").replace(/\s+/g, "").toLowerCase();

const toIdentity = (
  identity: VaultIdentity,
): recoveryservices.IdentityDataInput => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities?.length
    ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
    : undefined,
});

const identityDiffers = (
  observed: recoveryservices.IdentityData | undefined,
  desired: VaultIdentity | undefined,
) => {
  if (desired === undefined) return false;
  if (normalizeType(observed?.type) !== normalizeType(desired.type)) {
    return true;
  }
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return have.length !== want.length || have.some((id, i) => id !== want[i]);
};

/** True when any defined field of `desired` differs from `observed`. */
const differs = <T extends object>(observed: T | undefined, desired: T) =>
  (Object.keys(desired) as (keyof T)[]).some(
    (key) => desired[key] !== undefined && observed?.[key] !== desired[key],
  );

/** `value` without its `undefined` fields. */
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;

/** The vault-property delta between observed and desired state. */
const propertiesDelta = (
  observed: recoveryservices.VaultProperties | undefined,
  news: VaultProps,
) => {
  const delta: recoveryservices.VaultPropertiesInput = {};

  const publicNetworkAccess = news.publicNetworkAccess ?? "Enabled";
  if (observed?.publicNetworkAccess !== publicNetworkAccess) {
    delta.publicNetworkAccess = publicNetworkAccess;
  }

  // ARM rejects redundancy settings that omit either field.
  if (
    differs(observed?.redundancySettings, {
      standardTierStorageRedundancy: news.storageRedundancy,
      crossRegionRestore: news.crossRegionRestore,
    })
  ) {
    delta.redundancySettings = {
      standardTierStorageRedundancy:
        news.storageRedundancy ??
        observed?.redundancySettings?.standardTierStorageRedundancy ??
        "GeoRedundant",
      crossRegionRestore:
        news.crossRegionRestore ??
        observed?.redundancySettings?.crossRegionRestore ??
        "Disabled",
    };
  }

  if (news.crossSubscriptionRestore !== undefined) {
    const state =
      observed?.restoreSettings?.crossSubscriptionRestoreSettings
        ?.crossSubscriptionRestoreState;
    if (state !== news.crossSubscriptionRestore) {
      delta.restoreSettings = {
        crossSubscriptionRestoreSettings: {
          crossSubscriptionRestoreState: news.crossSubscriptionRestore,
        },
      };
    }
  }

  const security: recoveryservices.SecuritySettings = {};
  // Soft delete itself is `AlwaysON` on new vaults and cannot be turned
  // off; ARM only accepts the retention change with the observed states.
  const softDelete = observed?.securitySettings?.softDeleteSettings;
  if (
    news.softDeleteRetentionPeriodInDays !== undefined &&
    softDelete?.softDeleteRetentionPeriodInDays !==
      news.softDeleteRetentionPeriodInDays
  ) {
    security.softDeleteSettings = {
      softDeleteState: softDelete?.softDeleteState,
      softDeleteRetentionPeriodInDays: news.softDeleteRetentionPeriodInDays,
      enhancedSecurityState: softDelete?.enhancedSecurityState,
    };
  }
  if (
    news.immutability !== undefined &&
    observed?.securitySettings?.immutabilitySettings?.state !==
      news.immutability
  ) {
    security.immutabilitySettings = { state: news.immutability };
  }
  if (Object.keys(security).length > 0) delta.securitySettings = security;

  const monitoring = news.monitoringSettings;
  if (monitoring !== undefined) {
    const azureMonitor: recoveryservices.AzureMonitorAlertSettings = {
      alertsForAllJobFailures: monitoring.alertsForAllJobFailures,
      alertsForAllReplicationIssues: monitoring.alertsForAllReplicationIssues,
      alertsForAllFailoverIssues: monitoring.alertsForAllFailoverIssues,
    };
    const classic: recoveryservices.ClassicAlertSettings = {
      alertsForCriticalOperations:
        monitoring.classicAlertsForCriticalOperations,
      emailNotificationsForSiteRecovery:
        monitoring.emailNotificationsForSiteRecovery,
    };
    const observedMonitoring = observed?.monitoringSettings;
    if (
      differs(observedMonitoring?.azureMonitorAlertSettings, azureMonitor) ||
      differs(observedMonitoring?.classicAlertSettings, classic)
    ) {
      delta.monitoringSettings = {
        azureMonitorAlertSettings: {
          ...observedMonitoring?.azureMonitorAlertSettings,
          ...defined(azureMonitor),
        },
        classicAlertSettings: {
          ...observedMonitoring?.classicAlertSettings,
          ...defined(classic),
        },
      };
    }
  }

  const encryption = news.encryption;
  if (encryption !== undefined) {
    const observedEncryption = observed?.encryption;
    const kek = encryption.userAssignedIdentity
      ? { userAssignedIdentity: encryption.userAssignedIdentity }
      : { useSystemAssignedIdentity: true };
    if (
      observedEncryption?.keyVaultProperties?.keyUri !== encryption.keyUri ||
      lower(observedEncryption?.kekIdentity?.userAssignedIdentity) !==
        lower(encryption.userAssignedIdentity) ||
      (encryption.infrastructureEncryption !== undefined &&
        observedEncryption?.infrastructureEncryption !==
          encryption.infrastructureEncryption)
    ) {
      delta.encryption = {
        keyVaultProperties: { keyUri: encryption.keyUri },
        kekIdentity: kek,
        infrastructureEncryption: encryption.infrastructureEncryption,
      };
    }
  }

  return delta;
};

const SKU = { name: "RS0", tier: "Standard" } as const;

/** Identity and network updates keep a vault `Updating` for about a minute. */
const whileVaultBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "RecoveryServicesVaultOperationInProgress",
  schedule: Schedule.spaced("10 seconds"),
  times: 18,
} as const;

export const VaultProvider = () =>
  Provider.succeed(Vault, {
    stables: ["vaultName", "vaultId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* recoveryservices
        .ListVaultBySubscriptionId({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListVaultBySubscriptionId", page),
          ),
        );
      return (page.value ?? []).flatMap((vault) => {
        const group = resourceGroupOf(vault.id);
        return hasAnyAlchemyTag(vault.tags) &&
          group !== undefined &&
          vault.name !== undefined
          ? [toAttrs(group, vault.name, vault)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.vaultName)) ||
        (news.location !== undefined &&
          news.location.replace(/\s+/g, "").toLowerCase() !==
            output.location.replace(/\s+/g, "").toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.vaultName ?? olds?.name ?? (yield* createVaultName(id));
      const observed = yield* getVault(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.RecoveryServices");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.vaultName ?? (yield* createVaultName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: name,
      };
      const label = `recovery services vault ${name}`;
      const waitReady = () =>
        waitForProvisioned(
          label,
          getVault(subscriptionId, resourceGroup, name),
          (vault) => vault.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );

      // Observe.
      let observed = yield* getVault(subscriptionId, resourceGroup, name);

      // Ensure. The PUT stays minimal: a vault created with extra security
      // settings sits in `Provisioning` and is rolled back by Azure. The
      // remaining settings are applied by the sync PATCH below.
      if (observed === undefined) {
        yield* recoveryservices.VaultsCreateOrUpdate({
          ...where,
          location,
          sku: SKU,
          tags,
          identity: news.identity ? toIdentity(news.identity) : undefined,
          properties: {
            publicNetworkAccess: news.publicNetworkAccess ?? "Enabled",
          },
        });
      }
      observed = yield* waitReady();

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const delta = propertiesDelta(observed.properties, news);
      const identityChanged = identityDiffers(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(delta).length > 0 || identityChanged || tagsChanged) {
        yield* recoveryservices
          .UpdateVault({
            ...where,
            tags: tagsChanged ? tags : undefined,
            identity:
              identityChanged && news.identity
                ? toIdentity(news.identity)
                : undefined,
            properties: Object.keys(delta).length > 0 ? delta : undefined,
          })
          .pipe(Effect.retry(whileVaultBusy));
        observed = yield* waitReady();
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        recoveryservices
          .DeleteVault({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            vaultName: output.vaultName,
          })
          .pipe(Effect.retry(whileVaultBusy)),
      );
      yield* waitUntilGone(
        `recovery services vault ${output.vaultName}`,
        getVault(subscriptionId, output.resourceGroup, output.vaultName),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
