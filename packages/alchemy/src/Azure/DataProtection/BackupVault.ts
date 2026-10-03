import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import * as Effect from "effect/Effect";
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
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getVault, NAMESPACE, sameText } from "./Common.ts";

export type BackupDatastoreType =
  | "VaultStore"
  | "OperationalStore"
  | "ArchiveStore";
export type BackupRedundancy =
  | "LocallyRedundant"
  | "GeoRedundant"
  | "ZoneRedundant";
export type BackupVaultIdentityType =
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned"
  | "None";

export interface BackupVaultStorageSetting {
  /** Datastore the setting applies to. */
  datastoreType: BackupDatastoreType;
  /** Storage redundancy of the datastore. */
  type: BackupRedundancy;
}

export interface BackupVaultSoftDelete {
  /**
   * Soft-delete state. API version `2026-06-01` only accepts `AlwaysOn`
   * (irreversible) for new vaults.
   */
  state: "Off" | "On" | "AlwaysOn";
  /**
   * Days soft-deleted backup data is retained (14-180).
   * @default 14
   */
  retentionDurationInDays?: number;
}

export interface BackupVaultProps {
  /** Resource group the vault is created in. Changing it replaces the vault. */
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
  /**
   * Storage redundancy per datastore. Redundancy cannot change once data is
   * protected, so changing it replaces the vault.
   * @default [{ datastoreType: "VaultStore", type: "LocallyRedundant" }]
   */
  storageSettings?: BackupVaultStorageSetting[];
  /**
   * Managed identity type. The vault's identity needs RBAC roles on every
   * data source it protects.
   * @default "SystemAssigned"
   */
  identityType?: BackupVaultIdentityType;
  /**
   * ARM IDs of user-assigned managed identities, used with
   * `identityType: "UserAssigned"` or `"SystemAssigned,UserAssigned"`.
   */
  userAssignedIdentities?: string[];
  /**
   * Soft-delete settings. Azure requires `AlwaysOn` soft delete for new
   * vaults: a deleted vault is kept as a soft-deleted vault until its
   * scheduled purge (about a day for an empty vault), and deleted backup
   * data lingers (and blocks vault deletion) for the retention period.
   * @default { state: "AlwaysOn", retentionDurationInDays: 14 }
   */
  softDelete?: BackupVaultSoftDelete;
  /**
   * Immutability of the vault's recovery points. `Locked` is irreversible.
   * @default Azure's default (`Disabled`)
   */
  immutabilityState?: "Disabled" | "Unlocked" | "Locked";
  /**
   * Whether Azure Monitor raises an alert for every failed job.
   * @default Azure's default (`Enabled`)
   */
  alertsForAllJobFailures?: "Enabled" | "Disabled";
  /**
   * Cross-subscription restore. `PermanentlyDisabled` is irreversible.
   * @default Azure's default (`Enabled`)
   */
  crossSubscriptionRestoreState?:
    | "Enabled"
    | "Disabled"
    | "PermanentlyDisabled";
  /**
   * Cross-region restore; requires a `GeoRedundant` `VaultStore`.
   * @default Azure's default (`Disabled`)
   */
  crossRegionRestoreState?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface BackupVault extends Resource<
  "Azure.DataProtection.BackupVault",
  BackupVaultProps,
  {
    /** Name of the vault. */
    backupVaultName: string;
    /** ARM resource ID of the vault. */
    backupVaultId: string;
    /** Resource group that holds the vault. */
    resourceGroup: string;
    /** Location of the vault. */
    location: string;
    /** Storage redundancy per datastore. */
    storageSettings: BackupVaultStorageSetting[];
    /** Managed identity type. */
    identityType: string;
    /** Principal ID of the system-assigned identity; grant it roles on data sources. */
    principalId: string | undefined;
    /** Tenant of the system-assigned identity. */
    tenantId: string | undefined;
    /** Observed soft-delete state. */
    softDeleteState: string | undefined;
    /** Observed immutability state. */
    immutabilityState: string | undefined;
    /** Observed alert setting for failed jobs. */
    alertsForAllJobFailures: string | undefined;
    /** Whether a resource guard (multi-user authorization) protects the vault. */
    isVaultProtectedByResourceGuard: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Backup vault (`Microsoft.DataProtection/backupVaults`) — the
 * modern Azure Backup container for Blobs, Azure Disks, PostgreSQL flexible
 * servers, AKS clusters, and ADLS. Pair it with a
 * {@link BackupPolicy} and a {@link BackupInstance} to protect a data source.
 *
 * The vault gets a system-assigned managed identity by default; grant it the
 * data source's backup role (e.g. `Storage Account Backup Contributor`).
 *
 * Azure enforces `AlwaysOn` soft delete on new vaults, so deleting a vault
 * leaves a soft-deleted vault behind until Azure purges it (about a day for
 * an empty vault; the retention period when it held backup data).
 *
 * @see https://learn.microsoft.com/azure/backup/backup-vault-overview
 *
 * ### Creating a Backup Vault
 * **Example:** Locally redundant vault
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("backup");
 * const vault = yield* Azure.DataProtection.BackupVault("vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Geo-redundant vault with cross-region restore
 * ```typescript
 * const vault = yield* Azure.DataProtection.BackupVault("vault", {
 *   resourceGroup: group.resourceGroupName,
 *   storageSettings: [{ datastoreType: "VaultStore", type: "GeoRedundant" }],
 *   crossRegionRestoreState: "Enabled",
 *   softDelete: { state: "AlwaysOn", retentionDurationInDays: 30 },
 * });
 * ```
 *
 * ### Granting the Vault Access to a Data Source
 * **Example:** Role assignment for blob backup
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("vault-blob-backup", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: "e5e2a7ff-d759-4cd2-bb51-3152d37e2eb1", // Storage Account Backup Contributor
 *   principalId: vault.principalId!,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const BackupVault = Resource<BackupVault>(
  "Azure.DataProtection.BackupVault",
);

type ObservedVault = dataprotection.GetBackupVaultResponse;

const DEFAULT_STORAGE: BackupVaultStorageSetting[] = [
  { datastoreType: "VaultStore", type: "LocallyRedundant" },
];

const createVaultName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 50 });
  // Must start with a letter.
  return /^[a-zA-Z]/.test(name) ? name : `v${name.slice(0, 49)}`;
});

const toAttrs = (
  resourceGroup: string,
  name: string,
  vault: ObservedVault,
): BackupVault["Attributes"] => {
  const props = vault.properties ?? {};
  return {
    backupVaultName: name,
    backupVaultId: vault.id ?? "",
    resourceGroup,
    location: vault.location,
    storageSettings: (props.storageSettings ?? []).map((s) => ({
      datastoreType: s.datastoreType as BackupDatastoreType,
      type: s.type as BackupRedundancy,
    })),
    identityType: vault.identity?.type ?? "None",
    principalId: vault.identity?.principalId,
    tenantId: vault.identity?.tenantId,
    softDeleteState: props.securitySettings?.softDeleteSettings?.state,
    immutabilityState: props.securitySettings?.immutabilitySettings?.state,
    alertsForAllJobFailures:
      props.monitoringSettings?.azureMonitorAlertSettings
        ?.alertsForAllJobFailures,
    isVaultProtectedByResourceGuard:
      props.isVaultProtectedByResourceGuard ?? false,
    tags: userTags(vault.tags),
  };
};

const storageKey = (settings: BackupVaultStorageSetting[]) =>
  settings
    .map((s) => `${s.datastoreType}:${s.type}`.toLowerCase())
    .sort()
    .join(",");

const identityOf = (
  type: BackupVaultIdentityType,
  userAssigned: string[] | undefined,
): dataprotection.DppIdentityDetailsInput => ({
  type,
  userAssignedIdentities:
    userAssigned && userAssigned.length > 0
      ? Object.fromEntries(userAssigned.map((id) => [id, {}]))
      : undefined,
});

export const BackupVaultProvider = () =>
  Provider.succeed(BackupVault, {
    stables: ["backupVaultName", "backupVaultId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* dataprotection
        .GetBackupVaultInSubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("GetBackupVaultInSubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((vault) => {
        const group = resourceGroupOf(vault.id);
        return hasAnyAlchemyTag(vault.tags) &&
          group !== undefined &&
          vault.name !== undefined
          ? [
              toAttrs(group, vault.name, {
                ...vault,
                location: vault.location ?? "",
                properties: vault.properties ?? {},
              } as ObservedVault),
            ]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.backupVaultName) ||
        (news.location !== undefined &&
          !sameText(
            news.location.replaceAll(" ", ""),
            output.location.replaceAll(" ", ""),
          )) ||
        storageKey(news.storageSettings ?? DEFAULT_STORAGE) !==
          storageKey(output.storageSettings)
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
        output?.backupVaultName ?? olds?.name ?? (yield* createVaultName(id));
      const observed = yield* getVault(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.backupVaultName ?? (yield* createVaultName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const identityType = news.identityType ?? "SystemAssigned";
      const identity = identityOf(identityType, news.userAssignedIdentities);
      const softDelete = {
        state: news.softDelete?.state ?? "AlwaysOn",
        retentionDurationInDays: news.softDelete?.retentionDurationInDays ?? 14,
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: name,
      };
      const label = `backup vault ${name}`;
      const get = getVault(subscriptionId, resourceGroup, name);
      const settle = () =>
        waitForProvisioned(
          label,
          get,
          (vault) => vault.properties?.provisioningState,
          { interval: "3 seconds", times: 60 },
        );

      // Observe.
      let observed = yield* get;

      // Ensure. PUT is an ARM async operation (201/202).
      if (observed === undefined) {
        yield* dataprotection.BackupVaultsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity,
          properties: {
            storageSettings: news.storageSettings ?? DEFAULT_STORAGE,
            securitySettings: {
              softDeleteSettings: softDelete,
              immutabilitySettings: news.immutabilityState
                ? { state: news.immutabilityState }
                : undefined,
            },
            monitoringSettings: news.alertsForAllJobFailures
              ? {
                  azureMonitorAlertSettings: {
                    alertsForAllJobFailures: news.alertsForAllJobFailures,
                  },
                }
              : undefined,
            featureSettings:
              news.crossRegionRestoreState || news.crossSubscriptionRestoreState
                ? {
                    crossRegionRestoreSettings: news.crossRegionRestoreState
                      ? { state: news.crossRegionRestoreState }
                      : undefined,
                    crossSubscriptionRestoreSettings:
                      news.crossSubscriptionRestoreState
                        ? { state: news.crossSubscriptionRestoreState }
                        : undefined,
                  }
                : undefined,
          },
        });
      }
      observed = yield* settle();

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const patch: dataprotection.PatchBackupVaultInput = {};
      const observedSoftDelete = props.securitySettings?.softDeleteSettings;
      const softDeleteChanged =
        observedSoftDelete?.state !== softDelete.state ||
        (softDelete.state !== "Off" &&
          observedSoftDelete?.retentionDurationInDays !==
            softDelete.retentionDurationInDays);
      const immutabilityChanged =
        news.immutabilityState !== undefined &&
        props.securitySettings?.immutabilitySettings?.state !==
          news.immutabilityState;
      if (softDeleteChanged || immutabilityChanged) {
        patch.securitySettings = {
          softDeleteSettings: softDeleteChanged ? softDelete : undefined,
          immutabilitySettings: immutabilityChanged
            ? { state: news.immutabilityState }
            : undefined,
        };
      }
      if (
        news.alertsForAllJobFailures !== undefined &&
        props.monitoringSettings?.azureMonitorAlertSettings
          ?.alertsForAllJobFailures !== news.alertsForAllJobFailures
      ) {
        patch.monitoringSettings = {
          azureMonitorAlertSettings: {
            alertsForAllJobFailures: news.alertsForAllJobFailures,
          },
        };
      }
      const crrChanged =
        news.crossRegionRestoreState !== undefined &&
        props.featureSettings?.crossRegionRestoreSettings?.state !==
          news.crossRegionRestoreState;
      const csrChanged =
        news.crossSubscriptionRestoreState !== undefined &&
        props.featureSettings?.crossSubscriptionRestoreSettings?.state !==
          news.crossSubscriptionRestoreState;
      if (crrChanged || csrChanged) {
        patch.featureSettings = {
          crossRegionRestoreSettings: crrChanged
            ? { state: news.crossRegionRestoreState }
            : undefined,
          crossSubscriptionRestoreSettings: csrChanged
            ? { state: news.crossSubscriptionRestoreState }
            : undefined,
        };
      }
      const observedUserAssigned = Object.keys(
        observed.identity?.userAssignedIdentities ?? {},
      )
        .map((k) => k.toLowerCase())
        .sort()
        .join(",");
      const desiredUserAssigned = (news.userAssignedIdentities ?? [])
        .map((k) => k.toLowerCase())
        .sort()
        .join(",");
      const identityChanged =
        !sameText(
          (observed.identity?.type ?? "None").replaceAll(" ", ""),
          identityType,
        ) || observedUserAssigned !== desiredUserAssigned;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(patch).length > 0 || identityChanged || tagsChanged) {
        yield* dataprotection.UpdateBackupVault({
          ...where,
          properties: Object.keys(patch).length > 0 ? patch : undefined,
          identity: identityChanged ? identity : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* settle();
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dataprotection.DeleteBackupVault({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: output.backupVaultName,
        }),
      );
      yield* waitUntilGone(
        `backup vault ${output.backupVaultName}`,
        getVault(subscriptionId, output.resourceGroup, output.backupVaultName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
