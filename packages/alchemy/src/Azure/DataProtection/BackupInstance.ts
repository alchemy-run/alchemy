import * as dataprotection from "@distilled.cloud/azure/dataprotection";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getVault, isSubset, NAMESPACE, sameText } from "./Common.ts";

/** The data source (or data source set) a backup instance protects. */
export interface BackupInstanceDataSource {
  /** Full ARM ID of the resource to protect. */
  resourceID: string;
  /**
   * Data source type, e.g. `Microsoft.Storage/storageAccounts/blobServices`,
   * `Microsoft.Compute/disks`, `Microsoft.DBforPostgreSQL/flexibleServers/databases`.
   */
  datasourceType: string;
  /**
   * Name of the resource.
   * @default the last segment of `resourceID`
   */
  resourceName?: string;
  /**
   * ARM type of the resource, e.g. `Microsoft.Storage/storageAccounts`.
   * @default derived from `resourceID`
   */
  resourceType?: string;
  /**
   * Location of the resource.
   * @default the vault's location
   */
  resourceLocation?: string;
  /**
   * URI of the resource.
   * @default `resourceID`
   */
  resourceUri?: string;
}

/** Datastore parameters of a policy assignment. */
export interface BackupInstanceDataStoreParameters {
  /** e.g. `AzureOperationalStoreParameters`. */
  objectType: string;
  /** Datastore the parameters apply to. */
  dataStoreType: "OperationalStore" | "VaultStore" | "ArchiveStore";
  /** Snapshot resource group ID (disk and AKS operational backups). */
  resourceGroupId?: string;
}

/** Data source parameters of a policy assignment. */
export interface BackupInstanceDatasourceParameters {
  /** e.g. `BlobBackupDatasourceParameters`. */
  objectType: string;
  /** Blob containers to back up (vaulted blob backup). */
  containersList?: string[];
}

export interface BackupInstanceProps {
  /** Resource group of the Backup vault. Changing it replaces the instance. */
  resourceGroup: string;
  /** Name of the Backup vault. Changing it replaces the instance. */
  backupVault: string;
  /**
   * Backup instance name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the instance.
   */
  name?: string;
  /** Data source to protect. Changing it replaces the instance. */
  dataSource: BackupInstanceDataSource;
  /**
   * Data source set (the parent resource), required by some data source
   * types such as PostgreSQL databases and AKS. Changing it replaces the
   * instance.
   */
  dataSourceSet?: BackupInstanceDataSource;
  /** ARM ID of the {@link BackupPolicy} to protect the data source with. */
  policyId: string;
  /** Datastore parameters (e.g. snapshot resource group for disks). */
  dataStoreParameters?: BackupInstanceDataStoreParameters[];
  /** Data source parameters (e.g. containers for vaulted blob backup). */
  datasourceParameters?: BackupInstanceDatasourceParameters[];
  /**
   * Friendly name shown in the portal. Set at creation only: Azure ignores
   * friendly-name changes on an existing instance.
   * @default the data source's name
   */
  friendlyName?: string;
  /**
   * ARM ID of a user-assigned identity of the vault to protect with. If
   * omitted, the vault's system-assigned identity is used.
   */
  userAssignedIdentityId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface BackupInstance extends Resource<
  "Azure.DataProtection.BackupInstance",
  BackupInstanceProps,
  {
    /** Name of the backup instance. */
    backupInstanceName: string;
    /** ARM resource ID of the backup instance. */
    backupInstanceId: string;
    /** Backup vault that holds the instance. */
    backupVault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM ID of the protected resource. */
    dataSourceId: string;
    /** ARM ID of the policy the instance is protected with. */
    policyId: string;
    /** Friendly name. */
    friendlyName: string | undefined;
    /** Current protection state, e.g. `ProtectionConfigured`. */
    currentProtectionState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Protects a data source with a backup policy in an Azure Backup vault
 * (`Microsoft.DataProtection/backupVaults/backupInstances`).
 *
 * The vault's managed identity needs the data source's backup role before
 * protection can be configured (e.g. `Storage Account Backup Contributor`
 * on a storage account, `Disk Backup Reader` on a disk). Deploy blocks until
 * the instance reaches `ProtectionConfigured`. Deleting the instance stops
 * protection and deletes its backup data; vaulted backup data is retained
 * as soft-deleted (and blocks vault deletion) for the vault's soft-delete
 * retention period.
 *
 * @see https://learn.microsoft.com/azure/backup/blob-backup-configure-manage
 *
 * ### Protecting Blobs
 * **Example:** Operational backup of a storage account's blobs
 * ```typescript
 * const vault = yield* Azure.DataProtection.BackupVault("vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const access = yield* Azure.Authorization.RoleAssignment("vault-access", {
 *   scope: account.storageAccountId,
 *   roleDefinitionId: "e5e2a7ff-d759-4cd2-bb51-3152d37e2eb1", // Storage Account Backup Contributor
 *   principalId: vault.principalId!,
 *   principalType: "ServicePrincipal",
 * });
 * const policy = yield* Azure.DataProtection.BackupPolicy("blobs", {
 *   resourceGroup: group.resourceGroupName,
 *   backupVault: vault.backupVaultName,
 *   datasourceTypes: ["Microsoft.Storage/storageAccounts/blobServices"],
 *   policyRules: [
 *     {
 *       objectType: "AzureRetentionRule",
 *       name: "Default",
 *       isDefault: true,
 *       lifecycles: [
 *         {
 *           deleteAfter: { objectType: "AbsoluteDeleteOption", duration: "P30D" },
 *           sourceDataStore: { dataStoreType: "OperationalStore", objectType: "DataStoreInfoBase" },
 *         },
 *       ],
 *     },
 *   ],
 * });
 * const instance = yield* Azure.DataProtection.BackupInstance("blobs", {
 *   resourceGroup: group.resourceGroupName,
 *   backupVault: vault.backupVaultName,
 *   policyId: policy.backupPolicyId,
 *   dataSource: {
 *     resourceID: account.storageAccountId,
 *     datasourceType: "Microsoft.Storage/storageAccounts/blobServices",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const BackupInstance = Resource<BackupInstance>(
  "Azure.DataProtection.BackupInstance",
);

export class BackupProtectionFailed extends Data.TaggedError(
  "Azure.DataProtection.BackupProtectionFailed",
)<{
  readonly backupInstance: string;
  readonly state: string;
  readonly message: string;
}> {}

const FAILED_PROTECTION = new Set([
  "ConfiguringProtectionFailed",
  "ProtectionError",
  "Invalid",
]);

const createInstanceName = Effect.fn(function* (id: string) {
  return yield* createPhysicalName({ id, maxLength: 64 });
});

const getInstance = (
  subscriptionId: string,
  resourceGroupName: string,
  vaultName: string,
  backupInstanceName: string,
) =>
  orUndefinedIfNotFound(
    dataprotection.GetBackupInstance({
      subscriptionId,
      resourceGroupName,
      vaultName,
      backupInstanceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  backupVault: string,
  name: string,
  instance: dataprotection.GetBackupInstanceResponse,
): BackupInstance["Attributes"] => ({
  backupInstanceName: name,
  backupInstanceId: instance.id ?? "",
  backupVault,
  resourceGroup,
  dataSourceId: instance.properties?.dataSourceInfo.resourceID ?? "",
  policyId: instance.properties?.policyInfo.policyId ?? "",
  friendlyName: instance.properties?.friendlyName,
  currentProtectionState: instance.properties?.currentProtectionState,
  tags: userTags(instance.tags),
});

/** `Microsoft.Storage/storageAccounts` from `/subscriptions/../providers/Microsoft.Storage/storageAccounts/name`. */
const armTypeOf = (resourceId: string) => {
  const parts = resourceId.split("/providers/").pop()?.split("/") ?? [];
  const types = [parts[0]];
  for (let i = 1; i < parts.length; i += 2) types.push(parts[i]);
  return types.join("/");
};

const toDatasource = (
  source: BackupInstanceDataSource,
  objectType: "Datasource" | "DatasourceSet",
  defaultLocation: string,
) => ({
  objectType,
  resourceID: source.resourceID,
  datasourceType: source.datasourceType,
  resourceName: source.resourceName ?? source.resourceID.split("/").pop(),
  resourceType: source.resourceType ?? armTypeOf(source.resourceID),
  resourceLocation: source.resourceLocation ?? defaultLocation,
  resourceUri: source.resourceUri ?? source.resourceID,
});

export const BackupInstanceProvider = () =>
  Provider.succeed(BackupInstance, {
    stables: [
      "backupInstanceName",
      "backupInstanceId",
      "backupVault",
      "resourceGroup",
      "dataSourceId",
    ],

    // Instances live inside a vault; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.backupVault, output.backupVault) ||
        (news.name !== undefined && news.name !== output.backupInstanceName) ||
        !sameText(news.dataSource.resourceID, output.dataSourceId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const backupVault = output?.backupVault ?? olds?.backupVault;
      if (resourceGroup === undefined || backupVault === undefined) {
        return undefined;
      }
      const name =
        output?.backupInstanceName ??
        olds?.name ??
        (yield* createInstanceName(id));
      const observed = yield* getInstance(
        subscriptionId,
        resourceGroup,
        backupVault,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, backupVault, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, backupVault } = news;
      const name =
        news.name ??
        output?.backupInstanceName ??
        (yield* createInstanceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getInstance(subscriptionId, resourceGroup, backupVault, name);
      const label = `backup instance ${name}`;

      const vault = yield* getVault(subscriptionId, resourceGroup, backupVault);
      const defaultLocation = vault?.location ?? env.location;
      const dataSourceInfo = toDatasource(
        news.dataSource,
        "Datasource",
        defaultLocation,
      );
      const friendlyName = news.friendlyName ?? dataSourceInfo.resourceName;
      const policyParameters =
        news.dataStoreParameters || news.datasourceParameters
          ? {
              dataStoreParametersList: news.dataStoreParameters,
              backupDatasourceParametersList: news.datasourceParameters,
            }
          : undefined;

      // Observe.
      const observed = yield* get;
      const current = observed?.properties;

      // Ensure + sync: the PUT is an async upsert; send it when the
      // instance is missing or its policy, parameters, or tags drifted.
      // (Azure keeps the friendly name of an existing instance.)
      if (
        current === undefined ||
        !sameText(current.policyInfo.policyId, news.policyId) ||
        !isSubset(policyParameters, current.policyInfo.policyParameters) ||
        tagsDiffer(observed?.tags, tags)
      ) {
        yield* dataprotection.BackupInstancesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vaultName: backupVault,
          backupInstanceName: name,
          tags,
          properties: {
            objectType: "BackupInstance",
            friendlyName: current?.friendlyName ?? friendlyName,
            dataSourceInfo,
            dataSourceSetInfo: news.dataSourceSet
              ? toDatasource(
                  news.dataSourceSet,
                  "DatasourceSet",
                  defaultLocation,
                )
              : undefined,
            policyInfo: { policyId: news.policyId, policyParameters },
            identityDetails: news.userAssignedIdentityId
              ? {
                  useSystemAssignedIdentity: false,
                  userAssignedIdentityArmUrl: news.userAssignedIdentityId,
                }
              : undefined,
          },
        });
      }

      // Block until protection is configured.
      const fresh = yield* waitForProvisioned(
        label,
        get,
        (instance) => {
          const state = instance.properties?.provisioningState;
          if (state !== undefined && state !== "Succeeded") return state;
          const protection = instance.properties?.currentProtectionState;
          if (protection === undefined || protection === "ProtectionConfigured")
            return "Succeeded";
          // Map protection failures to a terminal provisioning failure.
          return FAILED_PROTECTION.has(protection) ? "Failed" : protection;
        },
        { interval: "5 seconds", times: 60 },
      ).pipe(
        Effect.catchTag("Azure.ProvisioningFailed", (e) =>
          get.pipe(
            Effect.flatMap((instance) =>
              Effect.fail(
                new BackupProtectionFailed({
                  backupInstance: name,
                  state:
                    instance?.properties?.currentProtectionState ?? e.state,
                  message:
                    instance?.properties?.protectionErrorDetails?.message ??
                    instance?.properties?.protectionStatus?.errorDetails
                      ?.message ??
                    e.message,
                }),
              ),
            ),
          ),
        ),
      );
      return toAttrs(resourceGroup, backupVault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dataprotection.DeleteBackupInstance({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vaultName: output.backupVault,
          backupInstanceName: output.backupInstanceName,
        }),
      );
      yield* waitUntilGone(
        `backup instance ${output.backupInstanceName}`,
        getInstance(
          subscriptionId,
          output.resourceGroup,
          output.backupVault,
          output.backupInstanceName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
