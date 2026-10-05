import { isResolved } from "../../Diff.ts";
import * as datashare from "@distilled.cloud/azure/datashare";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOwnedByStack,
  createChildName,
  immutableChanged,
  kindProperties,
  stringProp,
} from "./internal.ts";

export type DataSetKind =
  | "Blob"
  | "Container"
  | "BlobFolder"
  | "AdlsGen2FileSystem"
  | "AdlsGen2Folder"
  | "AdlsGen2File"
  | "KustoCluster"
  | "KustoDatabase"
  | "KustoTable"
  | "SqlDBTable"
  | "SqlDWTable"
  | "SynapseWorkspaceSqlPoolTable";

/** Table-level sharing filters for a `KustoTable` data set. */
export interface TableLevelSharingProperties {
  /** External tables to exclude. */
  externalTablesToExclude?: string[];
  /** External tables to include. */
  externalTablesToInclude?: string[];
  /** Materialized views to exclude. */
  materializedViewsToExclude?: string[];
  /** Materialized views to include. */
  materializedViewsToInclude?: string[];
  /** Tables to exclude. */
  tablesToExclude?: string[];
  /** Tables to include. */
  tablesToInclude?: string[];
}

/**
 * Kind-specific pointer to the shared source. Set the members the chosen
 * `kind` requires (Azure rejects missing or extra members):
 *
 * - `Container`: `subscriptionId`, `resourceGroup`, `storageAccountName`, `containerName`
 * - `Blob`: the `Container` members + `filePath`
 * - `BlobFolder`: the `Container` members + `prefix`
 * - `AdlsGen2FileSystem`: `subscriptionId`, `resourceGroup`, `storageAccountName`, `fileSystem`
 * - `AdlsGen2Folder`: the `AdlsGen2FileSystem` members + `folderPath`
 * - `AdlsGen2File`: the `AdlsGen2FileSystem` members + `filePath`
 * - `KustoCluster`: `kustoClusterResourceId`
 * - `KustoDatabase`: `kustoDatabaseResourceId`
 * - `KustoTable`: `kustoDatabaseResourceId` + `tableLevelSharingProperties`
 * - `SqlDBTable`: `sqlServerResourceId`, `databaseName`, `schemaName`, `tableName`
 * - `SqlDWTable`: `sqlServerResourceId`, `dataWarehouseName`, `schemaName`, `tableName`
 * - `SynapseWorkspaceSqlPoolTable`: `synapseWorkspaceSqlPoolTableResourceId`
 */
export interface DataSetSource {
  /** Subscription of the source storage account. */
  subscriptionId?: string;
  /** Resource group of the source storage account. */
  resourceGroup?: string;
  /** Name of the source storage account. */
  storageAccountName?: string;
  /** Blob container (`Container`, `Blob`, `BlobFolder`). */
  containerName?: string;
  /** Path of the shared file (`Blob`, `AdlsGen2File`). */
  filePath?: string;
  /** Blob prefix of the shared folder (`BlobFolder`). */
  prefix?: string;
  /** ADLS Gen2 file system (`AdlsGen2*`). */
  fileSystem?: string;
  /** Path of the shared folder (`AdlsGen2Folder`). */
  folderPath?: string;
  /** Resource ID of the Azure Data Explorer cluster (`KustoCluster`). */
  kustoClusterResourceId?: string;
  /** Resource ID of the Azure Data Explorer database (`KustoDatabase`, `KustoTable`). */
  kustoDatabaseResourceId?: string;
  /** Table filters (`KustoTable`). */
  tableLevelSharingProperties?: TableLevelSharingProperties;
  /** Resource ID of the SQL server (`SqlDBTable`, `SqlDWTable`). */
  sqlServerResourceId?: string;
  /** SQL database (`SqlDBTable`). */
  databaseName?: string;
  /** Dedicated SQL pool (`SqlDWTable`). */
  dataWarehouseName?: string;
  /** Table schema (`SqlDBTable`, `SqlDWTable`). */
  schemaName?: string;
  /** Table name (`SqlDBTable`, `SqlDWTable`). */
  tableName?: string;
  /** Resource ID of the Synapse SQL pool table (`SynapseWorkspaceSqlPoolTable`). */
  synapseWorkspaceSqlPoolTableResourceId?: string;
}

export interface DataSetProps {
  /** Resource group of the Data Share account. Changing it replaces the data set. */
  resourceGroup: string;
  /** Data Share account that offers the share. Changing it replaces the data set. */
  account: string;
  /** Share the data set is added to. Changing it replaces the data set. */
  share: string;
  /**
   * Data set name: letters, digits, and `_`, starting with a letter. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the data set.
   */
  name?: string;
  /** Kind of source. Changing it replaces the data set. */
  kind: DataSetKind;
  /**
   * Kind-specific pointer to the shared source. Data sets are immutable:
   * changing any member replaces the data set.
   */
  source: DataSetSource;
}

export interface DataSet extends Resource<
  "Azure.DataShare.DataSet",
  DataSetProps,
  {
    /** Name of the data set. */
    dataSetName: string;
    /** Share the data set belongs to. */
    shareName: string;
    /** Data Share account that offers the share. */
    accountName: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** ARM resource ID of the data set. */
    dataSetArmId: string;
    /**
     * Unique data set ID. Consumers reference it from an
     * `Azure.DataShare.DataSetMapping` to map the data set into their store.
     */
    dataSetId: string;
    /** Kind of source. */
    kind: string;
  },
  never,
  Providers
> {}

/**
 * A data set in an Azure Data Share share — a pointer to the storage
 * container, folder, file, Azure Data Explorer database, or SQL table
 * being shared. Data sets are immutable; any change replaces them.
 *
 * Snapshots need the share's account managed identity to read the source
 * (e.g. `Storage Blob Data Reader` on the storage account).
 *
 * @see https://learn.microsoft.com/azure/data-share/how-to-share-from-storage
 *
 * ### Sharing Storage
 * **Example:** Share a blob container
 * ```typescript
 * const reader = yield* Azure.Authorization.RoleAssignment("share-reads", {
 *   scope: storage.storageAccountId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.StorageBlobDataReader,
 *   principalId: account.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * const dataSet = yield* Azure.DataShare.DataSet("exports", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   share: share.shareName,
 *   kind: "Container",
 *   source: {
 *     subscriptionId,
 *     resourceGroup: group.resourceGroupName,
 *     storageAccountName: storage.storageAccountName,
 *     containerName: container.containerName,
 *   },
 * });
 * ```
 *
 * **Example:** Share a folder of a blob container
 * ```typescript
 * yield* Azure.DataShare.DataSet("daily", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   share: share.shareName,
 *   kind: "BlobFolder",
 *   source: {
 *     subscriptionId,
 *     resourceGroup: group.resourceGroupName,
 *     storageAccountName: storage.storageAccountName,
 *     containerName: container.containerName,
 *     prefix: "daily/",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataSet = Resource<DataSet>("Azure.DataShare.DataSet");

type ObservedDataSet =
  | datashare.GetDataSetResponse
  | datashare.CreateDataSetResponse;

const getDataSet = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  shareName: string,
  dataSetName: string,
) =>
  orUndefinedIfNotFound(
    datashare.GetDataSet({
      subscriptionId,
      resourceGroupName,
      accountName,
      shareName,
      dataSetName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  accountName: string,
  shareName: string,
  name: string,
  dataSet: ObservedDataSet,
): DataSet["Attributes"] => ({
  dataSetName: name,
  shareName,
  accountName,
  resourceGroup,
  dataSetArmId: dataSet.id ?? "",
  dataSetId: stringProp(kindProperties(dataSet), "dataSetId") ?? "",
  kind: dataSet.kind,
});

const ci = { caseInsensitive: true };

export const DataSetProvider = () =>
  Provider.succeed(DataSet, {
    stables: [
      "dataSetName",
      "shareName",
      "accountName",
      "resourceGroup",
      "dataSetArmId",
      "dataSetId",
      "kind",
    ],

    // Data sets vanish with their share; the account carries the ownership tags.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Every prop is immutable; an unresolved one comes from an upstream
      // resource being created or replaced.
      // An unresolved props object comes from an upstream replacement; every
      // prop is immutable, so that is a replace.
      if (!isResolved(news)) return { action: "replace" } as const;
      const next = news;
      if (
        immutableChanged(next.resourceGroup, output.resourceGroup, ci) ||
        immutableChanged(next.account, output.accountName, ci) ||
        immutableChanged(next.share, output.shareName, ci) ||
        (next.name !== undefined &&
          immutableChanged(next.name, output.dataSetName, ci)) ||
        immutableChanged(next.kind, output.kind) ||
        (olds !== undefined && immutableChanged(next.source, olds.source))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.accountName ?? olds?.account;
      const share = output?.shareName ?? olds?.share;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        share === undefined
      ) {
        return undefined;
      }
      const name =
        output?.dataSetName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getDataSet(
        subscriptionId,
        resourceGroup,
        account,
        share,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, share, name, observed);
      return (yield* accountOwnedByStack(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DataShare");
      const { resourceGroup, account, share } = news;
      const name =
        news.name ?? output?.dataSetName ?? (yield* createChildName(id));
      const get = getDataSet(
        subscriptionId,
        resourceGroup,
        account,
        share,
        name,
      );

      // Observe. Data sets are immutable: every prop change replaces.
      const observed = yield* get;
      if (observed !== undefined) {
        return toAttrs(resourceGroup, account, share, name, observed);
      }

      // Ensure. The PUT is synchronous.
      const created = yield* datashare.CreateDataSet({
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        shareName: share,
        dataSetName: name,
        kind: news.kind,
        properties: news.source,
      });
      return toAttrs(resourceGroup, account, share, name, created);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datashare.DeleteDataSet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.accountName,
          shareName: output.shareName,
          dataSetName: output.dataSetName,
        }),
      );
      yield* waitUntilGone(
        `data share data set ${output.dataSetName}`,
        getDataSet(
          subscriptionId,
          output.resourceGroup,
          output.accountName,
          output.shareName,
          output.dataSetName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.DataShare.Account"],
    },
  });
