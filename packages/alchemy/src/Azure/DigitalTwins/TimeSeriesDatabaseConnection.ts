import * as digitaltwins from "@distilled.cloud/azure/digitaltwins";
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
  createChildName,
  instanceOwnedByStage,
  type ManagedIdentityReference,
} from "./Common.ts";

export interface TimeSeriesDatabaseConnectionProps {
  /** Resource group of the instance. Changing it replaces the connection. */
  resourceGroup: string;
  /** Digital Twins instance the connection belongs to. Changing it replaces the connection. */
  instance: string;
  /**
   * Connection name: 2-49 letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the connection.
   */
  name?: string;
  /** ARM resource ID of the Azure Data Explorer cluster. Changing it replaces the connection. */
  adxResourceId: string;
  /** URI of the Azure Data Explorer cluster, e.g. `https://{cluster}.{region}.kusto.windows.net`. Changing it replaces the connection. */
  adxEndpointUri: string;
  /** Azure Data Explorer database that receives the history. Changing it replaces the connection. */
  adxDatabaseName: string;
  /**
   * Table for twin and relationship property updates. Changing it replaces the connection.
   * @default "AdtPropertyEvents"
   */
  adxTableName?: string;
  /** Table for twin lifecycle events; not created when omitted. Changing it replaces the connection. */
  adxTwinLifecycleEventsTableName?: string;
  /** Table for relationship lifecycle events; not created when omitted. Changing it replaces the connection. */
  adxRelationshipLifecycleEventsTableName?: string;
  /** ARM resource ID of the Event Hubs namespace that buffers the history. Changing it replaces the connection. */
  eventHubNamespaceResourceId: string;
  /** Event Hubs namespace URL, e.g. `sb://{namespace}.servicebus.windows.net`. Changing it replaces the connection. */
  eventHubEndpointUri: string;
  /** Event hub name inside the namespace. Changing it replaces the connection. */
  eventHubEntityPath: string;
  /**
   * Consumer group Azure Data Explorer reads with. Changing it replaces the connection.
   * @default "$Default"
   */
  eventHubConsumerGroup?: string;
  /**
   * Whether property and item removals are recorded in the table.
   * Changing it replaces the connection.
   * @default false
   */
  recordPropertyAndItemRemovals?: boolean;
  /**
   * Identity the instance uses to reach Event Hubs and Azure Data Explorer.
   * Changing it replaces the connection.
   * @default the instance's system-assigned identity
   */
  identity?: ManagedIdentityReference;
  /**
   * Whether deleting the connection also removes the artifacts it created
   * (the Azure Data Explorer data connection). Recorded data is kept.
   * @default true
   */
  cleanupConnectionArtifacts?: boolean;
}

export interface TimeSeriesDatabaseConnection extends Resource<
  "Azure.DigitalTwins.TimeSeriesDatabaseConnection",
  TimeSeriesDatabaseConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** Instance the connection belongs to. */
    instance: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Connection type (`AzureDataExplorer`). */
    connectionType: string;
    /** Azure Data Explorer database that receives the history. */
    adxDatabaseName: string | undefined;
    /** Table that receives property updates. */
    adxTableName: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Whether delete removes the connection artifacts. */
    cleanupConnectionArtifacts: boolean;
  },
  never,
  Providers
> {}

/**
 * A data history connection of an Azure Digital Twins instance — streams
 * twin property updates and lifecycle events through an Event Hub into an
 * Azure Data Explorer database.
 *
 * The instance's identity needs `Azure Event Hubs Data Owner` on the event
 * hub and `Contributor` on the Data Explorer cluster plus the database
 * `Admin` principal role. Every property is immutable: any change replaces
 * the connection.
 *
 * @see https://learn.microsoft.com/azure/digital-twins/concepts-data-history
 *
 * ### Creating a Data History Connection
 * **Example:** History into Azure Data Explorer
 * ```typescript
 * const twins = yield* Azure.DigitalTwins.Instance("factory", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * const history = yield* Azure.DigitalTwins.TimeSeriesDatabaseConnection(
 *   "history",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     instance: twins.instanceName,
 *     adxResourceId: cluster.clusterId,
 *     adxEndpointUri: cluster.uri,
 *     adxDatabaseName: database.databaseName,
 *     eventHubNamespaceResourceId: namespace.namespaceId,
 *     eventHubEndpointUri: `sb://${namespace.namespaceName}.servicebus.windows.net`,
 *     eventHubEntityPath: hub.eventHubName,
 *     adxTwinLifecycleEventsTableName: "TwinLifecycle",
 *   },
 * );
 * ```
 *
 * @resource
 */
export const TimeSeriesDatabaseConnection =
  Resource<TimeSeriesDatabaseConnection>(
    "Azure.DigitalTwins.TimeSeriesDatabaseConnection",
  );

type ObservedConnection = digitaltwins.GetTimeSeriesDatabaseConnectionResponse;

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
  timeSeriesDatabaseConnectionName: string,
) =>
  orUndefinedIfNotFound(
    digitaltwins.GetTimeSeriesDatabaseConnection({
      subscriptionId,
      resourceGroupName,
      resourceName,
      timeSeriesDatabaseConnectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  instance: string,
  name: string,
  cleanupConnectionArtifacts: boolean,
  observed: ObservedConnection,
): TimeSeriesDatabaseConnection["Attributes"] => ({
  connectionName: name,
  instance,
  resourceGroup,
  connectionId: observed.id ?? "",
  connectionType: observed.properties?.connectionType ?? "AzureDataExplorer",
  adxDatabaseName: observed.properties?.adxDatabaseName ?? undefined,
  adxTableName: observed.properties?.adxTableName ?? undefined,
  provisioningState: observed.properties?.provisioningState,
  cleanupConnectionArtifacts,
});

/** Props whose change replaces the connection (there is no update API). */
const immutableOf = (props: TimeSeriesDatabaseConnectionProps) => ({
  adxResourceId: props.adxResourceId.toLowerCase(),
  adxEndpointUri: props.adxEndpointUri.replace(/\/+$/, "").toLowerCase(),
  adxDatabaseName: props.adxDatabaseName,
  adxTableName: props.adxTableName,
  adxTwinLifecycleEventsTableName: props.adxTwinLifecycleEventsTableName,
  adxRelationshipLifecycleEventsTableName:
    props.adxRelationshipLifecycleEventsTableName,
  eventHubNamespaceResourceId: props.eventHubNamespaceResourceId.toLowerCase(),
  eventHubEndpointUri: props.eventHubEndpointUri
    .replace(/\/+$/, "")
    .toLowerCase(),
  eventHubEntityPath: props.eventHubEntityPath,
  eventHubConsumerGroup: props.eventHubConsumerGroup,
  recordPropertyAndItemRemovals: props.recordPropertyAndItemRemovals ?? false,
  identityType: props.identity?.type,
  userAssignedIdentity: props.identity?.userAssignedIdentity?.toLowerCase(),
});

export const TimeSeriesDatabaseConnectionProvider = () =>
  Provider.succeed(TimeSeriesDatabaseConnection, {
    stables: ["connectionName", "instance", "resourceGroup", "connectionId"],

    // Connections live inside an instance; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameInstance =
        news.resourceGroup.toLowerCase() ===
          output.resourceGroup.toLowerCase() &&
        news.instance.toLowerCase() === output.instance.toLowerCase();
      if (!sameInstance) return { action: "replace" } as const;
      if (
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.connectionName.toLowerCase()) ||
        (olds !== undefined &&
          JSON.stringify(immutableOf(news)) !==
            JSON.stringify(immutableOf(olds)))
      ) {
        // An instance holds at most one connection ("Cannot create more
        // than one time series database connection"), so the old one must
        // go before its replacement is created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const instance = output?.instance ?? olds?.instance;
      if (resourceGroup === undefined || instance === undefined) {
        return undefined;
      }
      const name =
        output?.connectionName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        instance,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        instance,
        name,
        output?.cleanupConnectionArtifacts ??
          olds?.cleanupConnectionArtifacts ??
          true,
        observed,
      );
      return (yield* instanceOwnedByStage(
        subscriptionId,
        resourceGroup,
        instance,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DigitalTwins");
      const { resourceGroup, instance } = news;
      const name =
        news.name ?? output?.connectionName ?? (yield* createChildName(id));
      const get = getConnection(subscriptionId, resourceGroup, instance, name);
      const settle = waitForProvisioned(
        `time series database connection ${name}`,
        get,
        (connection) => connection.properties?.provisioningState,
        { interval: "5 seconds", times: 72 },
      );

      // Observe.
      let observed = yield* get;
      if (observed?.properties?.provisioningState === "Deleting") {
        yield* waitUntilGone(`time series database connection ${name}`, get, {
          interval: "5 seconds",
          times: 72,
        });
        observed = undefined;
      }

      // Ensure. There is no update API: every property is immutable and
      // a change is planned as a replacement, so only create when missing.
      if (observed === undefined) {
        yield* digitaltwins.TimeSeriesDatabaseConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          resourceName: instance,
          timeSeriesDatabaseConnectionName: name,
          properties: {
            connectionType: "AzureDataExplorer",
            identity: news.identity ?? { type: "SystemAssigned" },
            adxResourceId: news.adxResourceId,
            adxEndpointUri: news.adxEndpointUri,
            adxDatabaseName: news.adxDatabaseName,
            adxTableName: news.adxTableName,
            adxTwinLifecycleEventsTableName:
              news.adxTwinLifecycleEventsTableName,
            adxRelationshipLifecycleEventsTableName:
              news.adxRelationshipLifecycleEventsTableName,
            eventHubNamespaceResourceId: news.eventHubNamespaceResourceId,
            eventHubEndpointUri: news.eventHubEndpointUri,
            eventHubEntityPath: news.eventHubEntityPath,
            eventHubConsumerGroup: news.eventHubConsumerGroup,
            recordPropertyAndItemRemovals:
              news.recordPropertyAndItemRemovals === undefined
                ? undefined
                : String(news.recordPropertyAndItemRemovals),
          },
        });
      }
      observed = yield* settle;

      return toAttrs(
        resourceGroup,
        instance,
        name,
        news.cleanupConnectionArtifacts ?? true,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        digitaltwins.DeleteTimeSeriesDatabaseConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.instance,
          timeSeriesDatabaseConnectionName: output.connectionName,
          cleanupConnectionArtifacts: output.cleanupConnectionArtifacts,
        }),
      );
      yield* waitUntilGone(
        `time series database connection ${output.connectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.instance,
          output.connectionName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),
  });
