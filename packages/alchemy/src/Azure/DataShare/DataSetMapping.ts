import * as datashare from "@distilled.cloud/azure/datashare";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
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
import type { DataSetKind } from "./DataSet.ts";
import {
  accountOwnedByStack,
  createChildName,
  immutableChanged,
  kindProperties,
  stringProp,
} from "./internal.ts";

/**
 * Kind-specific pointer to the consumer's target store. Set the members
 * the chosen `kind` requires (Azure rejects missing or extra members):
 *
 * - `Container`: `subscriptionId`, `resourceGroup`, `storageAccountName`, `containerName`
 * - `Blob`: the `Container` members + `filePath` (+ optional `outputType`)
 * - `BlobFolder`: the `Container` members + `prefix`
 * - `AdlsGen2FileSystem`: `subscriptionId`, `resourceGroup`, `storageAccountName`, `fileSystem`
 * - `AdlsGen2Folder`: the `AdlsGen2FileSystem` members + `folderPath`
 * - `AdlsGen2File`: the `AdlsGen2FileSystem` members + `filePath` (+ optional `outputType`)
 * - `KustoCluster` / `KustoDatabase` / `KustoTable`: `kustoClusterResourceId`
 * - `SqlDBTable`: `sqlServerResourceId`, `databaseName`, `schemaName`, `tableName`
 * - `SqlDWTable`: `sqlServerResourceId`, `dataWarehouseName`, `schemaName`, `tableName`
 * - `SynapseWorkspaceSqlPoolTable`: `synapseWorkspaceSqlPoolTableResourceId`
 */
export interface DataSetMappingTarget {
  /** Subscription of the target storage account. */
  subscriptionId?: string;
  /** Resource group of the target storage account. */
  resourceGroup?: string;
  /** Name of the target storage account. */
  storageAccountName?: string;
  /** Target blob container (`Container`, `Blob`, `BlobFolder`). */
  containerName?: string;
  /** Target file path (`Blob`, `AdlsGen2File`). */
  filePath?: string;
  /** Target blob prefix (`BlobFolder`). */
  prefix?: string;
  /** Target ADLS Gen2 file system (`AdlsGen2*`). */
  fileSystem?: string;
  /** Target folder path (`AdlsGen2Folder`). */
  folderPath?: string;
  /** File format of SQL-sourced data written to storage (`Csv` or `Parquet`). */
  outputType?: "Csv" | "Parquet";
  /** Resource ID of the target Azure Data Explorer cluster (`Kusto*`). */
  kustoClusterResourceId?: string;
  /** Resource ID of the target SQL server (`SqlDBTable`, `SqlDWTable`). */
  sqlServerResourceId?: string;
  /** Target SQL database (`SqlDBTable`). */
  databaseName?: string;
  /** Target dedicated SQL pool (`SqlDWTable`). */
  dataWarehouseName?: string;
  /** Target table schema (`SqlDBTable`, `SqlDWTable`). */
  schemaName?: string;
  /** Target table name (`SqlDBTable`, `SqlDWTable`). */
  tableName?: string;
  /** Resource ID of the target Synapse SQL pool table (`SynapseWorkspaceSqlPoolTable`). */
  synapseWorkspaceSqlPoolTableResourceId?: string;
}

export interface DataSetMappingProps {
  /** Resource group of the consumer Data Share account. Changing it replaces the mapping. */
  resourceGroup: string;
  /** Consumer Data Share account. Changing it replaces the mapping. */
  account: string;
  /** Share subscription that received the data set. Changing it replaces the mapping. */
  shareSubscription: string;
  /**
   * Mapping name: letters, digits, and `_`, starting with a letter. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the mapping.
   */
  name?: string;
  /** Kind of target store. Changing it replaces the mapping. */
  kind: DataSetKind;
  /**
   * `dataSetId` of the received data set (the provider's
   * `Azure.DataShare.DataSet` `dataSetId`). Changing it replaces the mapping.
   */
  dataSetId: string;
  /**
   * Kind-specific pointer to the target store. Mappings are immutable:
   * changing any member replaces the mapping.
   */
  target: DataSetMappingTarget;
}

export interface DataSetMapping extends Resource<
  "Azure.DataShare.DataSetMapping",
  DataSetMappingProps,
  {
    /** Name of the mapping. */
    dataSetMappingName: string;
    /** Share subscription the mapping belongs to. */
    shareSubscriptionName: string;
    /** Consumer Data Share account. */
    accountName: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the mapping. */
    dataSetMappingId: string;
    /** Data set the mapping receives. */
    dataSetId: string;
    /** Kind of target store. */
    kind: string;
    /** `Ok` or `Broken` (the source data set was removed). */
    dataSetMappingStatus: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string;
  },
  never,
  Providers
> {}

/**
 * Maps a data set received through a share subscription into a store the
 * consumer owns. Snapshots of the data set are written to the target.
 * Mappings are immutable; any change replaces them.
 *
 * Snapshots need the consumer account's managed identity to write the
 * target (e.g. `Storage Blob Data Contributor` on the storage account).
 *
 * @see https://learn.microsoft.com/azure/data-share/subscribe-to-data-share
 *
 * ### Receiving Data
 * **Example:** Map a shared container into a consumer container
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("consumer-writes", {
 *   scope: targetStorage.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataContributor,
 *   principalId: consumerAccount.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * yield* Azure.DataShare.DataSetMapping("exports", {
 *   resourceGroup: consumerGroup.resourceGroupName,
 *   account: consumerAccount.accountName,
 *   shareSubscription: subscription.shareSubscriptionName,
 *   kind: "Container",
 *   dataSetId: dataSet.dataSetId,
 *   target: {
 *     subscriptionId,
 *     resourceGroup: consumerGroup.resourceGroupName,
 *     storageAccountName: targetStorage.storageAccountName,
 *     containerName: targetContainer.containerName,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataSetMapping = Resource<DataSetMapping>(
  "Azure.DataShare.DataSetMapping",
);

type ObservedMapping =
  | datashare.GetDataSetMappingResponse
  | datashare.CreateDataSetMappingResponse;

const getMapping = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  shareSubscriptionName: string,
  dataSetMappingName: string,
) =>
  orUndefinedIfNotFound(
    datashare.GetDataSetMapping({
      subscriptionId,
      resourceGroupName,
      accountName,
      shareSubscriptionName,
      dataSetMappingName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  accountName: string,
  shareSubscriptionName: string,
  name: string,
  mapping: ObservedMapping,
): DataSetMapping["Attributes"] => {
  const props = kindProperties(mapping);
  return {
    dataSetMappingName: name,
    shareSubscriptionName,
    accountName,
    resourceGroup,
    dataSetMappingId: mapping.id ?? "",
    dataSetId: stringProp(props, "dataSetId") ?? "",
    kind: mapping.kind,
    dataSetMappingStatus: stringProp(props, "dataSetMappingStatus"),
    provisioningState: stringProp(props, "provisioningState") ?? "Succeeded",
  };
};

const ci = { caseInsensitive: true };

export const DataSetMappingProvider = () =>
  Provider.succeed(DataSetMapping, {
    stables: [
      "dataSetMappingName",
      "shareSubscriptionName",
      "accountName",
      "resourceGroup",
      "dataSetMappingId",
      "dataSetId",
      "kind",
    ],

    // Mappings vanish with their share subscription; the account carries the
    // ownership tags.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Every prop is immutable; an unresolved one comes from an upstream
      // resource being created or replaced.
      const next = news as unknown as Record<keyof DataSetMappingProps, unknown>;
      if (
        immutableChanged(next.resourceGroup, output.resourceGroup, ci) ||
        immutableChanged(next.account, output.accountName, ci) ||
        immutableChanged(
          next.shareSubscription,
          output.shareSubscriptionName,
          ci,
        ) ||
        (next.name !== undefined &&
          immutableChanged(next.name, output.dataSetMappingName, ci)) ||
        immutableChanged(next.kind, output.kind) ||
        immutableChanged(next.dataSetId, output.dataSetId) ||
        (olds !== undefined && immutableChanged(next.target, olds.target))
      ) {
        // A share subscription maps each data set once.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.accountName ?? olds?.account;
      const shareSubscription =
        output?.shareSubscriptionName ?? olds?.shareSubscription;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        shareSubscription === undefined
      ) {
        return undefined;
      }
      const name =
        output?.dataSetMappingName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getMapping(
        subscriptionId,
        resourceGroup,
        account,
        shareSubscription,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        shareSubscription,
        name,
        observed,
      );
      return (yield* accountOwnedByStack(subscriptionId, resourceGroup, account))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataShare");
      const { resourceGroup, account, shareSubscription } = news;
      const name =
        news.name ?? output?.dataSetMappingName ?? (yield* createChildName(id));
      const get = getMapping(
        subscriptionId,
        resourceGroup,
        account,
        shareSubscription,
        name,
      );

      // Observe. Mappings are immutable: every prop change replaces.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* datashare.CreateDataSetMapping({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          shareSubscriptionName: shareSubscription,
          dataSetMappingName: name,
          kind: news.kind,
          properties: { ...news.target, dataSetId: news.dataSetId },
        });
      }

      const fresh = yield* waitForProvisioned(
        `data share data set mapping ${name}`,
        get,
        (mapping) => stringProp(kindProperties(mapping), "provisioningState"),
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, account, shareSubscription, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datashare.DeleteDataSetMapping({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
          shareSubscriptionName: output.shareSubscriptionName,
          dataSetMappingName: output.dataSetMappingName,
        }),
      );
      yield* waitUntilGone(
        `data share data set mapping ${output.dataSetMappingName}`,
        getMapping(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
          output.shareSubscriptionName,
          output.dataSetMappingName,
        ),
        { interval: "3 seconds", times: 40 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DataShare.Account"],
    },
  });
