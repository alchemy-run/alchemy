import * as kusto from "@distilled.cloud/azure/azure_kusto";
import * as Effect from "effect/Effect";
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
  clusterLocation,
  createKustoChildName,
  isClusterOwnedByStack,
  lower,
  sameId,
  untilConverged,
  whileClusterBusy,
} from "./common.ts";

export type KustoDataConnectionKind =
  | "EventHub"
  | "EventGrid"
  | "IotHub"
  | "CosmosDb";

export interface DataConnectionProps {
  /** Resource group of the cluster. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the cluster. Changing it replaces the connection. */
  cluster: string;
  /** Name of the target database. Changing it replaces the connection. */
  database: string;
  /**
   * Connection name. If omitted, a unique name is generated from the app,
   * stage, and logical ID (at most 40 characters). Changing it replaces
   * the connection.
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
   */
  eventHubResourceId?: string;
  /**
   * Event hub / IoT hub consumer group to read with. Changing it replaces
   * the connection.
   */
  consumerGroup?: string;
  /** Table the data is ingested into (can come from message properties instead). */
  tableName?: string;
  /** Ingestion mapping used to map messages to columns. */
  mappingRuleName?: string;
  /** Message format, e.g. `JSON`, `MULTIJSON`, `CSV`, `PARQUET`. */
  dataFormat?: string;
  /** Message compression (`None` or `GZip`, EventHub only). */
  compression?: "None" | "GZip";
  /** Event hub / IoT hub system properties to ingest with each message. */
  eventSystemProperties?: string[];
  /** Resource ID of the managed identity used to read the source. */
  managedIdentityResourceId?: string;
  /**
   * `Single` ingests into `database` only; `Multi` lets messages override
   * the target database. Changing it replaces the connection.
   */
  databaseRouting?: "Single" | "Multi";
  /**
   * Ingest only events enqueued after this time (ISO-8601). Changing it
   * replaces the connection.
   */
  retrievalStartDate?: string;
  /** Storage account whose blob events are ingested (`EventGrid`). Changing it replaces the connection. */
  storageAccountResourceId?: string;
  /** Event Grid subscription resource ID (`EventGrid`). Changing it replaces the connection. */
  eventGridResourceId?: string;
  /** Ignore the first record of every blob (`EventGrid`). */
  ignoreFirstRecord?: boolean;
  /** Blob event type that triggers ingestion (`EventGrid`). */
  blobStorageEventType?:
    | "Microsoft.Storage.BlobCreated"
    | "Microsoft.Storage.BlobRenamed";
  /** IoT hub resource ID (`IotHub`). Changing it replaces the connection. */
  iotHubResourceId?: string;
  /** IoT hub shared access policy name (`IotHub`). */
  sharedAccessPolicyName?: string;
  /** Cosmos DB account resource ID (`CosmosDb`). Changing it replaces the connection. */
  cosmosDbAccountResourceId?: string;
  /** Cosmos DB database (`CosmosDb`). Changing it replaces the connection. */
  cosmosDbDatabase?: string;
  /** Cosmos DB container (`CosmosDb`). Changing it replaces the connection. */
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
 * Continuously ingests data into an Azure Data Explorer (Kusto) database
 * from an Event Hub, Event Grid (blob notifications), IoT Hub, or Cosmos DB
 * change feed. The target table and ingestion mapping must exist first —
 * create them with an `Azure.Kusto.Script`.
 *
 * @see https://learn.microsoft.com/azure/data-explorer/ingest-data-event-hub-overview
 *
 * ### Ingesting from Event Hubs
 * **Example:** Event Hub data connection
 * ```typescript
 * const schema = yield* Azure.Kusto.Script("schema", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   database: db.databaseName,
 *   content: ".create-merge table Events (Name: string)",
 * });
 * const connection = yield* Azure.Kusto.DataConnection("events", {
 *   resourceGroup: group.resourceGroupName,
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
 * @resource
 */
export const DataConnection = Resource<DataConnection>(
  "Azure.Kusto.DataConnection",
);

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

const desiredProperties = (
  news: DataConnectionProps,
): kusto.DataConnectionProperties => ({
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
        (olds !== undefined &&
          IDENTITY_FIELDS.some((key) => !sameId(news[key], olds[key])))
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
      if (
        resourceGroup === undefined ||
        cluster === undefined ||
        database === undefined
      ) {
        return undefined;
      }
      const name =
        output?.dataConnectionName ??
        olds?.name ??
        (yield* createKustoChildName(id, 40));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        cluster,
        database,
        name,
      );
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
      const name =
        news.name ??
        output?.dataConnectionName ??
        (yield* createKustoChildName(id, 40));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        clusterName: cluster,
        databaseName: database,
        dataConnectionName: name,
      };
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        cluster,
        database,
        name,
      );
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
            (key) =>
              properties[key] !== undefined && props[key] !== properties[key],
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
