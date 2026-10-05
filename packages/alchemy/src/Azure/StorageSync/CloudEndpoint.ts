import * as storagesync from "@distilled.cloud/azure/storagesync";
import * as Data from "effect/Data";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createChildName,
  isServiceOwnedByStack,
  sameName,
} from "./internal.ts";

export interface CloudEndpointProps {
  /**
   * Resource group of the Storage Sync Service. Changing it replaces the
   * cloud endpoint.
   */
  resourceGroup: string;
  /**
   * Name of the Storage Sync Service. Changing it replaces the cloud
   * endpoint.
   */
  storageSyncService: string;
  /** Name of the parent sync group. Changing it replaces the cloud endpoint. */
  syncGroup: string;
  /**
   * Name of the cloud endpoint. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the cloud endpoint.
   */
  name?: string;
  /**
   * ARM ID of the storage account that holds the file share, e.g.
   * `account.storageAccountId`. Changing it replaces the cloud endpoint.
   */
  storageAccountResourceId: string;
  /**
   * Name of the Azure file share to sync. A share can back only one cloud
   * endpoint. Changing it replaces the cloud endpoint.
   */
  azureFileShareName: string;
  /**
   * Entra tenant of the storage account. Changing it replaces the cloud
   * endpoint.
   * @default the tenant of the deploying credentials
   */
  storageAccountTenantId?: string;
  /**
   * Display name of the endpoint. Azure cannot rename an existing cloud
   * endpoint, so changing it replaces the endpoint.
   * @default chosen by Azure (the file share name)
   */
  friendlyName?: string;
  /**
   * How often, in days, Azure enumerates changes made directly on the file
   * share (0 disables change enumeration).
   * @default Azure's default
   */
  changeEnumerationIntervalDays?: number;
}

export interface CloudEndpoint extends Resource<
  "Azure.StorageSync.CloudEndpoint",
  CloudEndpointProps,
  {
    /** Name of the cloud endpoint. */
    cloudEndpointName: string;
    /** ARM resource ID of the cloud endpoint. */
    cloudEndpointId: string;
    /** Name of the parent sync group. */
    syncGroupName: string;
    /** Name of the Storage Sync Service. */
    storageSyncServiceName: string;
    /** Resource group of the Storage Sync Service. */
    resourceGroup: string;
    /** ARM ID of the storage account. */
    storageAccountResourceId: string | undefined;
    /** Name of the synced file share. */
    azureFileShareName: string | undefined;
    /** Entra tenant of the storage account. */
    storageAccountTenantId: string | undefined;
    /** Display name of the endpoint. */
    friendlyName: string | undefined;
    /** Change enumeration interval in days. */
    changeEnumerationIntervalDays: number | undefined;
    /** Partnership ID between the service and the file share. */
    partnershipId: string | undefined;
    /** Whether Azure Backup protects the share (`"true"`/`"false"`). */
    backupEnabled: string | undefined;
    /** ID of the last management workflow run on the endpoint. */
    lastWorkflowId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure File Sync cloud endpoint — attaches an Azure file share to a
 * sync group so registered servers in the group sync with it. Each sync
 * group has exactly one cloud endpoint, and a file share can back only one
 * cloud endpoint.
 *
 * Azure File Sync must be able to reach the storage account. Either grant
 * the `Microsoft.StorageSync` first-party service principal *Reader and
 * Data Access* on the account (the portal does this for you), or enable
 * the Storage Sync Service's managed identity (`useIdentity: true`) and
 * grant it *Reader and Data Access*, *Storage Account Contributor*, and
 * *Storage File Data Privileged Contributor* on the account. The
 * storage account must allow SMB 3.1.1, NTLMv2, and AES-128-GCM.
 *
 * @see https://learn.microsoft.com/azure/storage/file-sync/file-sync-deployment-guide
 *
 * ### Creating a Cloud Endpoint
 * **Example:** Sync a file share
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("files", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const share = yield* Azure.Storage.FileShare("docs", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * const sync = yield* Azure.StorageSync.StorageSyncService("sync", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 *   useIdentity: true,
 * });
 * // Reader and Data Access, Storage Account Contributor, and Storage File
 * // Data Privileged Contributor for the service's identity.
 * const grants = yield* Effect.forEach(
 *   [
 *     "c12c1c16-33a1-487b-954d-41c89c60f349",
 *     "17d1049b-9a84-46fb-8f53-869881c3d3ab",
 *     "69566ab7-960f-475b-8e7c-b3118f30c6bd",
 *   ],
 *   (role, i) =>
 *     Azure.Authorization.RoleAssignment(`sync-grant-${i}`, {
 *       scope: account.storageAccountId,
 *       roleDefinitionId: role,
 *       principalId: sync.principalId.as<string>(),
 *       principalType: "ServicePrincipal",
 *     }),
 * );
 * const syncGroup = yield* Azure.StorageSync.SyncGroup("docs", {
 *   resourceGroup: group.resourceGroupName,
 *   storageSyncService: sync.storageSyncServiceName,
 * });
 * yield* Azure.StorageSync.CloudEndpoint("docs-cloud", {
 *   resourceGroup: group.resourceGroupName,
 *   storageSyncService: sync.storageSyncServiceName,
 *   syncGroup: syncGroup.syncGroupName,
 *   // Wait for the grants before creating the endpoint.
 *   storageAccountResourceId: Output.all(
 *     account.storageAccountId,
 *     ...grants.map((grant) => grant.roleAssignmentId),
 *   ).pipe(Output.map(([accountId]) => accountId)),
 *   azureFileShareName: share.shareName,
 * });
 * ```
 *
 * ### Change Detection
 * **Example:** Enumerate direct share changes every 3 days
 * ```typescript
 * yield* Azure.StorageSync.CloudEndpoint("docs-cloud", {
 *   resourceGroup: group.resourceGroupName,
 *   storageSyncService: sync.storageSyncServiceName,
 *   syncGroup: syncGroup.syncGroupName,
 *   storageAccountResourceId: account.storageAccountId,
 *   azureFileShareName: share.shareName,
 *   changeEnumerationIntervalDays: 3,
 * });
 * ```
 *
 * @resource
 */
export const CloudEndpoint = Resource<CloudEndpoint>(
  "Azure.StorageSync.CloudEndpoint",
);

export class CloudEndpointCreateFailed extends Data.TaggedError(
  "Azure.StorageSync.CloudEndpointCreateFailed",
)<{ readonly message: string }> {}

type Observed = storagesync.GetCloudEndpointResponse;

const createCloudEndpointName = (id: string) => createChildName(id, 60);

const getCloudEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  storageSyncServiceName: string,
  syncGroupName: string,
  cloudEndpointName: string,
) =>
  orUndefinedIfNotFound(
    storagesync.GetCloudEndpoint({
      subscriptionId,
      resourceGroupName,
      storageSyncServiceName,
      syncGroupName,
      cloudEndpointName,
    }),
  );

/** Azure returns the tenant ID wrapped in literal quotes. */
const stripQuotes = (value: string | undefined) => value?.replace(/^"|"$/g, "");

const toAttrs = (
  resourceGroup: string,
  storageSyncServiceName: string,
  syncGroupName: string,
  name: string,
  observed: Observed,
): CloudEndpoint["Attributes"] => ({
  cloudEndpointName: name,
  cloudEndpointId: observed.id ?? "",
  syncGroupName,
  storageSyncServiceName,
  resourceGroup,
  storageAccountResourceId: observed.properties?.storageAccountResourceId,
  azureFileShareName: observed.properties?.azureFileShareName,
  storageAccountTenantId: stripQuotes(
    observed.properties?.storageAccountTenantId,
  ),
  friendlyName: observed.properties?.friendlyName,
  changeEnumerationIntervalDays:
    observed.properties?.changeEnumerationIntervalDays,
  partnershipId: observed.properties?.partnershipId,
  backupEnabled: observed.properties?.backupEnabled,
  lastWorkflowId: observed.properties?.lastWorkflowId,
});

export const CloudEndpointProvider = () =>
  Provider.succeed(CloudEndpoint, {
    stables: [
      "cloudEndpointName",
      "cloudEndpointId",
      "syncGroupName",
      "storageSyncServiceName",
      "resourceGroup",
      "storageAccountResourceId",
      "azureFileShareName",
      "partnershipId",
    ],

    // Cloud endpoints disappear with their sync group.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.storageSyncService, output.storageSyncServiceName) ||
        !sameName(news.syncGroup, output.syncGroupName) ||
        (news.name !== undefined &&
          !sameName(news.name, output.cloudEndpointName)) ||
        !sameName(
          news.storageAccountResourceId,
          output.storageAccountResourceId,
        ) ||
        news.azureFileShareName !== output.azureFileShareName ||
        (news.storageAccountTenantId !== undefined &&
          !sameName(
            news.storageAccountTenantId,
            output.storageAccountTenantId,
          )) ||
        (news.friendlyName !== undefined &&
          news.friendlyName !== output.friendlyName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const service =
        output?.storageSyncServiceName ?? olds?.storageSyncService;
      const syncGroup = output?.syncGroupName ?? olds?.syncGroup;
      if (
        resourceGroup === undefined ||
        service === undefined ||
        syncGroup === undefined
      ) {
        return undefined;
      }
      const name =
        output?.cloudEndpointName ??
        olds?.name ??
        (yield* createCloudEndpointName(id));
      const observed = yield* getCloudEndpoint(
        subscriptionId,
        resourceGroup,
        service,
        syncGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, service, syncGroup, name, observed);
      return (yield* isServiceOwnedByStack(
        subscriptionId,
        resourceGroup,
        service,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageSync");
      const { resourceGroup, storageSyncService, syncGroup } = news;
      const name =
        news.name ??
        output?.cloudEndpointName ??
        (yield* createCloudEndpointName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        storageSyncServiceName: storageSyncService,
        syncGroupName: syncGroup,
        cloudEndpointName: name,
      };
      const label = `cloud endpoint ${name}`;
      const get = getCloudEndpoint(
        subscriptionId,
        resourceGroup,
        storageSyncService,
        syncGroup,
        name,
      );
      const budget = { interval: "5 seconds", times: 60 } as const;

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation whose failure (e.g.
      // `MgmtStorageAccountAuthorizationFailed` while a fresh role grant
      // propagates) only shows as the endpoint never appearing, so the PUT
      // is re-sent until the endpoint exists.
      if (observed === undefined) {
        const create = storagesync.CreateCloudEndpoint({
          ...where,
          properties: {
            storageAccountResourceId: news.storageAccountResourceId,
            azureFileShareName: news.azureFileShareName,
            storageAccountTenantId: news.storageAccountTenantId ?? env.tenantId,
            friendlyName: news.friendlyName,
            changeEnumerationIntervalDays: news.changeEnumerationIntervalDays,
          },
        });
        const appeared = get.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (endpoint) => endpoint !== undefined,
            times: 6,
          }),
        );
        yield* create.pipe(
          Effect.andThen(appeared),
          Effect.flatMap((endpoint) =>
            endpoint === undefined
              ? Effect.fail(
                  new CloudEndpointCreateFailed({
                    message: `${label} was not created; check that Azure File Sync can read storage account ${news.storageAccountResourceId} (Reader and Data Access for the Microsoft.StorageSync principal, or roles for the service's managed identity)`,
                  }),
                )
              : Effect.void,
          ),
          Effect.retry({
            while: (e) =>
              e._tag === "Azure.StorageSync.CloudEndpointCreateFailed",
            times: 6,
          }),
        );
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (endpoint) => endpoint.properties?.provisioningState,
        budget,
      );

      // Sync the change enumeration interval against the observed value.
      if (
        news.changeEnumerationIntervalDays !== undefined &&
        observed.properties?.changeEnumerationIntervalDays !==
          news.changeEnumerationIntervalDays
      ) {
        yield* storagesync.UpdateCloudEndpoint({
          ...where,
          properties: {
            changeEnumerationIntervalDays: news.changeEnumerationIntervalDays,
          },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (endpoint) =>
            endpoint.properties?.changeEnumerationIntervalDays ===
            news.changeEnumerationIntervalDays
              ? endpoint.properties?.provisioningState
              : "Updating",
          budget,
        );
      }

      return toAttrs(
        resourceGroup,
        storageSyncService,
        syncGroup,
        name,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagesync.DeleteCloudEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageSyncServiceName: output.storageSyncServiceName,
          syncGroupName: output.syncGroupName,
          cloudEndpointName: output.cloudEndpointName,
        }),
      );
      yield* waitUntilGone(
        `cloud endpoint ${output.cloudEndpointName}`,
        getCloudEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.storageSyncServiceName,
          output.syncGroupName,
          output.cloudEndpointName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.StorageSync.SyncGroup",
        "Azure.StorageSync.StorageSyncService",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
