import * as kusto from "@distilled.cloud/azure/azure_kusto";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  clusterLocation,
  createKustoChildName,
  isClusterOwnedByStack,
  lower,
  sameId,
  untilConverged,
  whileClusterBusy,
} from "./common.ts";

export type KustoDataConnectionKind = "EventHub" | "EventGrid" | "IotHub" | "CosmosDb";

export interface DataConnectionProps {
  /**
   * Resource group of the cluster. Changing it replaces the connection.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the cluster. Changing it replaces the connection. */
  cluster: string;
  /** Name of the target database. Changing it replaces the connection. */
  database: string;
  /**
   * Connection name. If omitted, a unique name is generated from the app,
   * stage, and logical ID (at most 40 characters). Changing it replaces
   * the connection.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the connection.
   * @default the cluster's location
   */
  location?: string;
  /** Source kind. Changing it replaces the connection. */
  kind: KustoDataConnectionKind;
  /**
   * Resource ID of the event hub to read from (`EventHub`), or that
   * receives the Event Grid notifications (`EventGrid`). Changing it
   * replaces the connection.
   * @default unset
   */
  eventHubResourceId?: string;
  /**
   * Event hub / IoT hub consumer group to read with. Changing it replaces
   * the connection.
   * @default unset
   */
  consumerGroup?: string;
  /**
   * Table the data is ingested into (can come from message properties instead).
   * @default unset (the table comes from message properties)
   */
  tableName?: string;
  /**
   * Ingestion mapping used to map messages to columns.
   * @default unset
   */
  mappingRuleName?: string;
  /**
   * Message format, e.g. `JSON`, `MULTIJSON`, `CSV`, `PARQUET`.
   * @default unset (the format comes from message properties)
   */
  dataFormat?: string;
  /**
   * Message compression (`None` or `GZip`, EventHub only).
   * @default "None"
   */
  compression?: "None" | "GZip";
  /**
   * Event hub / IoT hub system properties to ingest with each message.
   * @default []
   */
  eventSystemProperties?: string[];
  /**
   * Resource ID of the managed identity used to read the source.
   * @default unset
   */
  managedIdentityResourceId?: string;
  /**
   * `Single` ingests into `database` only; `Multi` lets messages override
   * the target database. Changing it replaces the connection.
   * @default "Single"
   */
  databaseRouting?: "Single" | "Multi";
  /**
   * Ingest only events enqueued after this time (ISO-8601). Changing it
   * replaces the connection.
   * @default unset (events enqueued after creation)
   */
  retrievalStartDate?: string;
  /**
   * Storage account whose blob events are ingested (`EventGrid`). Changing it replaces the connection.
   * @default unset
   */
  storageAccountResourceId?: string;
  /**
   * Event Grid subscription resource ID (`EventGrid`). Changing it replaces the connection.
   * @default unset
   */
  eventGridResourceId?: string;
  /**
   * Ignore the first record of every blob (`EventGrid`).
   * @default false
   */
  ignoreFirstRecord?: boolean;
  /**
   * Blob event type that triggers ingestion (`EventGrid`).
   * @default "Microsoft.Storage.BlobCreated"
   */
  blobStorageEventType?: "Microsoft.Storage.BlobCreated" | "Microsoft.Storage.BlobRenamed";
  /**
   * IoT hub resource ID (`IotHub`). Changing it replaces the connection.
   * @default unset
   */
  iotHubResourceId?: string;
  /**
   * IoT hub shared access policy name (`IotHub`).
   * @default unset
   */
  sharedAccessPolicyName?: string;
  /**
   * Cosmos DB account resource ID (`CosmosDb`). Changing it replaces the connection.
   * @default unset
   */
  cosmosDbAccountResourceId?: string;
  /**
   * Cosmos DB database (`CosmosDb`). Changing it replaces the connection.
   * @default unset
   */
  cosmosDbDatabase?: string;
  /**
   * Cosmos DB container (`CosmosDb`). Changing it replaces the connection.
   * @default unset
   */
  cosmosDbContainer?: string;
}

export interface DataConnection extends Resource<
  "Azure.Kusto.DataConnection",
  DataConnectionProps,
  {
    /** Name of the data connection. */
    dataConnectionName: string;
    /** ARM resource ID of the data connection. */
    dataConnectionId: string;
    /** Cluster of the database. */
    cluster: string;
    /** Target database. */
    database: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** Location of the data connection. */
    location: string;
    /** Source kind. */
    kind: string;
    /** Target table, if fixed. */
    tableName: string | undefined;
    /** Ingestion mapping, if set. */
    mappingRuleName: string | undefined;
    /** Message format, if set. */
    dataFormat: string | undefined;
    /** Object ID of the managed identity used to read the source, if any. */
    managedIdentityObjectId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A data connection (`Microsoft.Kusto/clusters/databases/dataConnections`)
 * that continuously ingests data into an Azure Data Explorer (Kusto)
 * database from an Event Hub, Event Grid (blob notifications), IoT Hub, or
 * Cosmos DB change feed.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/ingest-data-event-hub-overview
 *
 * ### Ingesting from Event Hubs
 * **Example:** Event Hub data connection
 * ```typescript
 * const cluster = yield* Azure.Kusto.Cluster("adx");
 * const db = yield* Azure.Kusto.Database("telemetry", {
 *   cluster: cluster.clusterName,
 * });
 * const namespace = yield* Azure.EventHub.Namespace("events");
 * const hub = yield* Azure.EventHub.EventHub("events", {
 *   namespace: namespace.namespaceName,
 * });
 * const schema = yield* Azure.Kusto.Script("schema", {
 *   cluster: cluster.clusterName,
 *   database: db.databaseName,
 *   content: ".create-merge table Events (Name: string)",
 * });
 * const connection = yield* Azure.Kusto.DataConnection("events", {
 *   cluster: cluster.clusterName,
 *   database: db.databaseName,
 *   kind: "EventHub",
 *   eventHubResourceId: hub.eventHubId,
 *   consumerGroup: "$Default",
 *   tableName: "Events",
 *   dataFormat: "JSON",
 * });
 * ```
 *
 * :::caution
 * The target table and ingestion mapping must exist first. Create them
 * with an `Azure.Kusto.Script`.
 * :::
 *
 * :::caution
 * Changing `name`, `cluster`, `database`, `kind`, `location`,
 * `resourceGroup`, or any source field (`eventHubResourceId`,
 * `consumerGroup`, `databaseRouting`, `retrievalStartDate`,
 * `storageAccountResourceId`, `eventGridResourceId`, `iotHubResourceId`,
 * `cosmosDbAccountResourceId`, `cosmosDbDatabase`, `cosmosDbContainer`)
 * replaces the connection.
 * :::
 *
 * @resource
 */
export const DataConnection = GroupedResource<DataConnection>("Azure.Kusto.DataConnection");

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  clusterName: string,
  databaseName: string,
  dataConnectionName: string,
) =>
  orUndefinedIfNotFound(
    kusto.GetDataConnection({
      subscriptionId,
      resourceGroupName,
      clusterName,
      databaseName,
      dataConnectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  database: string,
  name: string,
  connection: kusto.GetDataConnectionResponse,
): DataConnection["Attributes"] => ({
  dataConnectionName: name,
  dataConnectionId: connection.id ?? "",
  cluster,
  database,
  resourceGroup,
  location: connection.location ?? "",
  kind: connection.kind,
  tableName: connection.properties?.tableName,
  mappingRuleName: connection.properties?.mappingRuleName,
  dataFormat: connection.properties?.dataFormat,
  managedIdentityObjectId: connection.properties?.managedIdentityObjectId,
});

/** Source identity fields: changing any of them replaces the connection. */
const IDENTITY_FIELDS = [
  "eventHubResourceId",
  "consumerGroup",
  "databaseRouting",
  "retrievalStartDate",
  "storageAccountResourceId",
  "eventGridResourceId",
  "iotHubResourceId",
  "cosmosDbAccountResourceId",
  "cosmosDbDatabase",
  "cosmosDbContainer",
] as const;

/** Mutable fields synced in place against the observed connection. */
const MUTABLE_FIELDS = [
  "tableName",
  "mappingRuleName",
  "dataFormat",
  "compression",
  "managedIdentityResourceId",
  "ignoreFirstRecord",
  "blobStorageEventType",
  "sharedAccessPolicyName",
] as const;

const desiredProperties = (news: DataConnectionProps): kusto.DataConnectionProperties => ({
  eventHubResourceId: news.eventHubResourceId,
  consumerGroup: news.consumerGroup,
  tableName: news.tableName,
  mappingRuleName: news.mappingRuleName,
  dataFormat: news.dataFormat,
  compression: news.compression,
  eventSystemProperties: news.eventSystemProperties,
  managedIdentityResourceId: news.managedIdentityResourceId,
  databaseRouting: news.databaseRouting,
  retrievalStartDate: news.retrievalStartDate,
  storageAccountResourceId: news.storageAccountResourceId,
  eventGridResourceId: news.eventGridResourceId,
  ignoreFirstRecord: news.ignoreFirstRecord,
  blobStorageEventType: news.blobStorageEventType,
  iotHubResourceId: news.iotHubResourceId,
  sharedAccessPolicyName: news.sharedAccessPolicyName,
  cosmosDbAccountResourceId: news.cosmosDbAccountResourceId,
  cosmosDbDatabase: news.cosmosDbDatabase,
  cosmosDbContainer: news.cosmosDbContainer,
});

export const DataConnectionProvider = () =>
  Provider.succeed(DataConnection, {
    stables: [
      "dataConnectionName",
      "dataConnectionId",
      "cluster",
      "database",
      "resourceGroup",
      "kind",
    ],

    // Data connections live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.cluster !== output.cluster ||
        news.database !== output.database ||
        (news.name !== undefined && news.name !== output.dataConnectionName) ||
        lower(news.kind) !== lower(output.kind) ||
        (news.location !== undefined &&
          lower(news.location)?.replace(/\s/g, "") !==
            lower(output.location)?.replace(/\s/g, "")) ||
        (olds !== undefined && IDENTITY_FIELDS.some((key) => !sameId(news[key], olds[key])))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      const database = output?.database ?? olds?.database;
      if (resourceGroup === undefined || cluster === undefined || database === undefined) {
        return undefined;
      }
      const name =
        output?.dataConnectionName ?? olds?.name ?? (yield* createKustoChildName(id, 40));
      const observed = yield* getConnection(subscriptionId, resourceGroup, cluster, database, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, database, name, observed);
      return output !== undefined ||
        (yield* isClusterOwnedByStack(subscriptionId, resourceGroup, cluster))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Kusto");
      const { resourceGroup, cluster, database } = news;
      const name = news.name ?? output?.dataConnectionName ?? (yield* createKustoChildName(id, 40));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        databaseName: database,
        dataConnectionName: name,
      };
      const get = getConnection(subscriptionId, resourceGroup, cluster, database, name);
      const waitReady = waitForProvisioned(
        `kusto data connection ${name}`,
        get,
        (c) => c.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      const properties = desiredProperties(news);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* clusterLocation(subscriptionId, resourceGroup, cluster));
        yield* kusto
          .DataConnectionsCreateOrUpdate({
            ...where,
            location,
            kind: news.kind,
            properties,
          })
          .pipe(Effect.retry(whileClusterBusy));
      }
      observed = yield* waitReady;

      // Sync mutable settings against observed state. The PATCH carries
      // the full property set because the per-kind required fields are
      // validated on every write.
      const drifted = (connection: NonNullable<typeof observed>) => {
        const props = connection.properties ?? {};
        return (
          MUTABLE_FIELDS.some(
            (key) => properties[key] !== undefined && props[key] !== properties[key],
          ) ||
          (news.eventSystemProperties !== undefined &&
            JSON.stringify([...(props.eventSystemProperties ?? [])].sort()) !==
              JSON.stringify([...news.eventSystemProperties].sort()))
        );
      };
      if (drifted(observed)) {
        yield* kusto
          .UpdateDataConnection({
            ...where,
            location: observed.location,
            kind: news.kind,
            properties,
          })
          .pipe(Effect.retry(whileClusterBusy));
        observed = yield* waitForProvisioned(
          `kusto data connection ${name}`,
          get,
          untilConverged(
            (c) => c.properties?.provisioningState,
            (c) => !drifted(c),
          ),
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, cluster, database, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        kusto
          .DeleteDataConnection({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            clusterName: output.cluster,
            databaseName: output.database,
            dataConnectionName: output.dataConnectionName,
          })
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `kusto data connection ${output.dataConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.cluster,
          output.database,
          output.dataConnectionName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),
  });
