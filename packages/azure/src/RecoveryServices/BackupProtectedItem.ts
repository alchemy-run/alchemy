import * as backup from "@distilled.cloud/azure/recoveryservicesbackup";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  collectAll,
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  ProvisioningTimedOut,
  resourceGroupOf,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  BACKUP_FABRIC,
  isVaultOwnedByStack,
  RECOVERY_SERVICES_NAMESPACE,
  sameId,
} from "./BackupShared.ts";

export type BackupProtectedItemType =
  | "AzureFileShareProtectedItem"
  | "Microsoft.Compute/virtualMachines"
  | "AzureVmWorkloadSQLDatabase"
  | "AzureVmWorkloadSAPHanaDatabase";

export interface BackupProtectedItemProps {
  /**
   * Resource group of the Recovery Services vault.
   *
   * :::caution
   * Changing it replaces the item and deletes its backup data.
   * :::
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the Recovery Services vault.
   *
   * :::caution
   * Changing it replaces the item and deletes its backup data.
   * :::
   */
  vault: string;
  /**
   * What is backed up: `AzureFileShareProtectedItem` (an Azure file share),
   * `Microsoft.Compute/virtualMachines` (an Azure VM), or a workload
   * database inside a VM.
   *
   * :::caution
   * Changing it replaces the item and deletes its backup data.
   * :::
   */
  protectedItemType: BackupProtectedItemType;
  /**
   * ARM ID of the source: the storage account for file shares, the VM for
   * VM backup.
   *
   * :::caution
   * Changing it replaces the item and deletes its backup data.
   * :::
   */
  sourceResourceId: string;
  /**
   * Container holding the item, e.g. a
   * {@link BackupProtectionContainer}'s `containerName`. Required for file
   * shares.
   *
   * :::caution
   * Changing it replaces the item and deletes its backup data.
   * :::
   * @default derived for VMs (`iaasvmcontainer;iaasvmcontainerv2;<rg>;<vm>`)
   */
  containerName?: string;
  /**
   * Name of the item to protect. For file shares, pass `friendlyName`
   * (the share name) instead and Alchemy discovers the item name.
   *
   * :::caution
   * Changing it replaces the item and deletes its backup data.
   * :::
   * @default derived for VMs (`VM;iaasvmcontainerv2;<rg>;<vm>`)
   */
  protectedItemName?: string;
  /**
   * Friendly name of the data source to discover, e.g. the file share
   * name.
   *
   * :::caution
   * Changing it replaces the item and deletes its backup data.
   * :::
   * @default none
   */
  friendlyName?: string;
  /** ARM ID of the {@link BackupPolicy} that protects the item. */
  policyId: string;
  /**
   * `Protected` runs scheduled backups; `ProtectionStopped` stops backups
   * but keeps existing recovery points.
   * @default "Protected"
   */
  protectionState?: "Protected" | "ProtectionStopped";
}

export interface BackupProtectedItem extends Resource<
  "Azure.RecoveryServices.BackupProtectedItem",
  BackupProtectedItemProps,
  {
    /** Name of the protected item. */
    protectedItemName: string;
    /** Container holding the item. */
    containerName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the protected item. */
    protectedItemId: string;
    /** ARM ID of the policy currently protecting the item. */
    policyId: string;
    /** Friendly name of the data source. */
    friendlyName: string;
    /** Observed protection state, e.g. `IRPending` until the first backup, then `Protected`. */
    protectionState: string;
    /** Status of the last backup, if any. */
    lastBackupStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A backup protected item
 * (`Microsoft.RecoveryServices/vaults/backupFabrics/protectionContainers/protectedItems`):
 * enables Azure Backup for a data source — an Azure file share or a
 * virtual machine — with a {@link BackupPolicy}.
 *
 * Protected items cannot be tagged; Alchemy treats an item as owned when
 * its vault is tagged for the current stack and stage. Changing the policy
 * updates the item in place.
 *
 * :::caution
 * Destroying the resource stops protection and deletes the backup data.
 * When soft delete is on (new vaults default to the irreversible
 * `AlwaysON`), Azure keeps the item soft-deleted for the retention period
 * (14 days by default), and you cannot delete the vault until it expires.
 * :::
 *
 * @see https://learn.microsoft.com/azure/backup/backup-azure-file-share-rest-api
 *
 * ### Azure Files
 * **Example:** Back up a file share daily
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("backup-vault");
 * const account = yield* Azure.Storage.StorageAccount("files");
 * const share = yield* Azure.Storage.FileShare("share", {
 *   storageAccount: account.storageAccountName,
 * });
 * const container = yield* Azure.RecoveryServices.BackupProtectionContainer(
 *   "files-container",
 *   {
 *     vault: vault.vaultName,
 *     sourceResourceId: account.storageAccountId,
 *   },
 * );
 * const policy = yield* Azure.RecoveryServices.BackupPolicy("policy", {
 *   vault: vault.vaultName,
 *   backupManagementType: "AzureStorage",
 *   workLoadType: "AzureFileShare",
 *   schedulePolicy: {
 *     schedulePolicyType: "SimpleSchedulePolicy",
 *     scheduleRunFrequency: "Daily",
 *     scheduleRunTimes: ["2026-01-01T23:00:00Z"],
 *   },
 *   retentionPolicy: {
 *     retentionPolicyType: "LongTermRetentionPolicy",
 *     dailySchedule: {
 *       retentionTimes: ["2026-01-01T23:00:00Z"],
 *       retentionDuration: { count: 7, durationType: "Days" },
 *     },
 *   },
 * });
 * yield* Azure.RecoveryServices.BackupProtectedItem("share-backup", {
 *   vault: vault.vaultName,
 *   protectedItemType: "AzureFileShareProtectedItem",
 *   sourceResourceId: account.storageAccountId,
 *   containerName: container.containerName,
 *   friendlyName: share.shareName,
 *   policyId: policy.policyId,
 * });
 * ```
 *
 * ### Virtual Machines
 * **Example:** Back up a VM
 * ```typescript
 * const vault = yield* Azure.RecoveryServices.Vault("backup-vault");
 * const vmPolicy = yield* Azure.RecoveryServices.BackupPolicy("vmPolicy", {
 *   vault: vault.vaultName,
 *   backupManagementType: "AzureIaasVM",
 *   schedulePolicy: {
 *     schedulePolicyType: "SimpleSchedulePolicy",
 *     scheduleRunFrequency: "Daily",
 *     scheduleRunTimes: ["2026-01-01T23:00:00Z"],
 *   },
 *   retentionPolicy: {
 *     retentionPolicyType: "LongTermRetentionPolicy",
 *     dailySchedule: {
 *       retentionTimes: ["2026-01-01T23:00:00Z"],
 *       retentionDuration: { count: 7, durationType: "Days" },
 *     },
 *   },
 * });
 * yield* Azure.RecoveryServices.BackupProtectedItem("vm-backup", {
 *   vault: vault.vaultName,
 *   protectedItemType: "Microsoft.Compute/virtualMachines",
 *   // ARM ID of an existing VM
 *   sourceResourceId:
 *     "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/web/providers/Microsoft.Compute/virtualMachines/web-01",
 *   policyId: vmPolicy.policyId,
 * });
 * ```
 *
 * @resource
 */
export const BackupProtectedItem = GroupedResource<BackupProtectedItem>(
  "Azure.RecoveryServices.BackupProtectedItem",
);

export class BackupItemNotDiscovered extends Data.TaggedError(
  "Azure.RecoveryServices.BackupItemNotDiscovered",
)<{
  readonly friendlyName: string;
  readonly message: string;
}> {}

type Observed = backup.GetProtectedItemResponse;

const nameOf = (armId: string) => armId.split("/").filter(Boolean).at(-1) ?? "";
const isVm = (type: string) => type.toLowerCase() === "microsoft.compute/virtualmachines";
const isFileShare = (type: string) => type.toLowerCase() === "azurefileshareprotecteditem";

const containerNameFor = (news: BackupProtectedItemProps) =>
  news.containerName ??
  (isVm(news.protectedItemType)
    ? `iaasvmcontainer;iaasvmcontainerv2;${resourceGroupOf(news.sourceResourceId)};${nameOf(news.sourceResourceId)}`
    : undefined);

/** The container segment of a protectable/protected item ARM ID. */
const containerOfId = (armId: string | undefined) =>
  armId?.match(/\/protectionContainers\/([^/]+)/i)?.[1];

const getItem = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  containerName: string,
  protectedItemName: string,
) =>
  orUndefinedIfNotFound(
    backup.GetProtectedItem({
      subscriptionId,
      resourceGroupName,
      vaultName,
      fabricName: BACKUP_FABRIC,
      containerName,
      protectedItemName,
    }),
  ).pipe(
    // A soft-deleted item is gone from the user's point of view.
    Effect.map((item) =>
      item?.properties?.isScheduledForDeferredDelete === true ? undefined : item,
    ),
  );

/**
 * Discover a file share's protected-item name from its friendly name:
 * first among already-protected items, then (after an inquiry) among
 * protectable items of the container.
 */
const discoverFileShareItemName = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  containerName: string,
  friendlyName: string,
) {
  const where = { subscriptionId, resourceGroupName, vaultName };
  const inContainer = (item: { id?: string }) => sameId(containerOfId(item.id), containerName);
  const protectedPage = yield* collectAll(backup.ListBackupProtectedItems, {
    ...where,
    _filter: "backupManagementType eq 'AzureStorage' and itemType eq 'AzureFileShare'",
  });
  const existing = (protectedPage.value ?? []).find(
    (item) =>
      inContainer(item) &&
      item.properties?.isScheduledForDeferredDelete !== true &&
      sameId(item.properties?.friendlyName, friendlyName),
  );
  if (existing?.name !== undefined) return existing.name;

  yield* backup.ProtectionContainersInquire({
    ...where,
    fabricName: BACKUP_FABRIC,
    containerName,
    _filter: "workloadType eq 'AzureFileShare'",
  });
  return yield* collectAll(backup.ListBackupProtectableItems, {
    ...where,
    _filter: "backupManagementType eq 'AzureStorage' and workloadType eq 'AzureFileShare'",
  }).pipe(
    Effect.flatMap((page) => {
      const found = (page.value ?? []).find(
        (item) => inContainer(item) && sameId(item.properties?.friendlyName, friendlyName),
      );
      return found?.name !== undefined
        ? Effect.succeed(found.name)
        : Effect.fail("pending" as const);
    }),
    Effect.retry({
      while: (e) => e === "pending",
      schedule: Schedule.spaced("5 seconds"),
      times: 24,
    }),
    Effect.catchIf(
      (e): e is "pending" => e === "pending",
      () =>
        Effect.fail(
          new BackupItemNotDiscovered({
            friendlyName,
            message: `file share '${friendlyName}' was not discovered in container ${containerName} after 2 minutes`,
          }),
        ),
    ),
  );
});

const toAttrs = (
  resourceGroup: string,
  vault: string,
  containerName: string,
  name: string,
  observed: Observed,
): BackupProtectedItem["Attributes"] => ({
  protectedItemName: name,
  containerName,
  vault,
  resourceGroup,
  protectedItemId: observed.id ?? "",
  policyId: observed.properties?.policyId ?? "",
  friendlyName: observed.properties?.friendlyName ?? "",
  protectionState: observed.properties?.protectionState ?? "",
  lastBackupStatus: observed.properties?.lastBackupStatus,
});

const stateMatches = (observed: Observed, desired: string) => {
  const state = (observed.properties?.protectionState ?? "").toLowerCase();
  return desired === "ProtectionStopped"
    ? state === "protectionstopped"
    : state !== "protectionstopped";
};

export const BackupProtectedItemProvider = () =>
  Provider.succeed(BackupProtectedItem, {
    stables: ["protectedItemName", "containerName", "vault", "resourceGroup", "protectedItemId"],

    // Protected items live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const containerName = containerNameFor(news);
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.vault.toLowerCase() !== output.vault.toLowerCase() ||
        (containerName !== undefined && !sameId(containerName, output.containerName)) ||
        (news.protectedItemName !== undefined &&
          !sameId(news.protectedItemName, output.protectedItemName)) ||
        (news.friendlyName !== undefined &&
          output.friendlyName !== "" &&
          !sameId(news.friendlyName, output.friendlyName)) ||
        (olds !== undefined &&
          (!sameId(news.sourceResourceId, olds.sourceResourceId) ||
            news.protectedItemType !== olds.protectedItemType))
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
      const containerName =
        output?.containerName ?? (olds !== undefined ? containerNameFor(olds) : undefined);
      if (containerName === undefined) return undefined;
      let name = output?.protectedItemName ?? olds?.protectedItemName;
      if (name === undefined && olds !== undefined) {
        name = isVm(olds.protectedItemType)
          ? `VM;iaasvmcontainerv2;${resourceGroupOf(olds.sourceResourceId)};${nameOf(olds.sourceResourceId)}`
          : undefined;
      }
      if (
        name === undefined &&
        olds?.friendlyName !== undefined &&
        isFileShare(olds.protectedItemType)
      ) {
        // Only look among already-protected items: read must not inquire.
        const page = yield* orUndefinedIfNotFound(
          collectAll(backup.ListBackupProtectedItems, {
            subscriptionId,
            resourceGroupName: resourceGroup,
            vaultName: vault,
            _filter: "backupManagementType eq 'AzureStorage' and itemType eq 'AzureFileShare'",
          }),
        );
        name = page?.value?.find(
          (item) =>
            sameId(containerOfId(item.id), containerName) &&
            item.properties?.isScheduledForDeferredDelete !== true &&
            sameId(item.properties?.friendlyName, olds.friendlyName),
        )?.name;
      }
      if (name === undefined) return undefined;
      const observed = yield* getItem(subscriptionId, resourceGroup, vault, containerName, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, vault, containerName, name, observed);
      return output !== undefined ||
        (yield* isVaultOwnedByStack(subscriptionId, resourceGroup, vault))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, RECOVERY_SERVICES_NAMESPACE);
      const { resourceGroup, vault, policyId, sourceResourceId } = news;
      const protectionState = news.protectionState ?? "Protected";
      const containerName = containerNameFor(news) ?? output?.containerName;
      if (containerName === undefined) {
        return yield* new BackupItemNotDiscovered({
          friendlyName: news.friendlyName ?? sourceResourceId,
          message: `containerName is required for ${news.protectedItemType} items`,
        });
      }

      // Resolve the item name: explicit, cached, derived, or discovered.
      const name =
        news.protectedItemName ??
        output?.protectedItemName ??
        (isVm(news.protectedItemType)
          ? `VM;iaasvmcontainerv2;${resourceGroupOf(sourceResourceId)};${nameOf(sourceResourceId)}`
          : yield* discoverFileShareItemName(
              subscriptionId,
              resourceGroup,
              vault,
              containerName,
              news.friendlyName ?? "",
            ));
      const get = getItem(subscriptionId, resourceGroup, vault, containerName, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync policy and protection state.
      const converged = (item: Observed | undefined) =>
        item !== undefined &&
        stateMatches(item, protectionState) &&
        (protectionState === "ProtectionStopped" || sameId(item.properties?.policyId, policyId));
      if (!converged(observed)) {
        yield* backup.ProtectedItemsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vaultName: vault,
          fabricName: BACKUP_FABRIC,
          containerName,
          protectedItemName: name,
          properties: {
            protectedItemType: news.protectedItemType,
            sourceResourceId,
            policyId: protectionState === "ProtectionStopped" ? "" : policyId,
            ...(protectionState === "ProtectionStopped" ? { protectionState } : {}),
          },
        });
      }

      // Enabling protection is asynchronous (202): wait until it applies.
      const fresh = yield* get.pipe(
        Effect.flatMap((item) =>
          converged(item) ? Effect.succeed(item!) : Effect.fail("pending" as const),
        ),
        Effect.retry({
          while: (e) => e === "pending",
          schedule: Schedule.spaced("5 seconds"),
          times: 48,
        }),
        Effect.catchIf(
          (e): e is "pending" => e === "pending",
          () =>
            Effect.fail(
              new ProvisioningTimedOut({
                resource: `backup protected item ${name}`,
                state: undefined,
                message: `backup protected item ${name} did not converge after 4 minutes`,
              }),
            ),
        ),
      );
      return toAttrs(resourceGroup, vault, containerName, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        backup.DeleteProtectedItem({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: output.vault,
          fabricName: BACKUP_FABRIC,
          containerName: output.containerName,
          protectedItemName: output.protectedItemName,
        }),
      );
      yield* waitUntilGone(
        `backup protected item ${output.protectedItemName}`,
        getItem(
          subscriptionId,
          output.resourceGroup,
          output.vault,
          output.containerName,
          output.protectedItemName,
        ),
        { interval: "5 seconds", times: 48 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Storage.*", "Azure.Resources.ResourceGroup"],
    },
  });
