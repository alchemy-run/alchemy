import * as confluent from "@distilled.cloud/azure/confluent";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  canonicalJson,
  isOrganizationOwnedByStack,
  type OrganizationChildProps,
  sameName,
} from "./common.ts";

export type ConnectorType = "SINK" | "SOURCE";

export type ConnectorServiceType =
  | "AzureBlobStorageSinkConnector"
  | "AzureBlobStorageSourceConnector"
  | "AzureCosmosDBSinkConnector"
  | "AzureCosmosDBSourceConnector"
  | "AzureSynapseAnalyticsSinkConnector";

export type PartnerConnectorType =
  | "KafkaAzureBlobStorageSource"
  | "KafkaAzureBlobStorageSink"
  | "KafkaAzureCosmosDBSource"
  | "KafkaAzureCosmosDBSink"
  | "KafkaAzureSynapseAnalyticsSink";

/**
 * Azure-side target of the connector, discriminated by
 * `connectorServiceType`. E.g. for `AzureBlobStorageSinkConnector`:
 * `{ storageAccountName, storageAccountKey, storageContainerName }`; for
 * `AzureCosmosDBSinkConnector`: `{ cosmosDatabaseName, cosmosMasterKey,
 * cosmosConnectionEndpoint, cosmosContainersTopicMapping, cosmosIdHandling }`;
 * for `AzureSynapseAnalyticsSinkConnector`: `{ synapseSqlServerName,
 * synapseSqlUser, synapseSqlPassword, synapseSqlDatabaseName }`.
 */
export interface ConnectorServiceTypeInfo {
  /** The Azure service the connector reads from or writes to. */
  connectorServiceType: ConnectorServiceType;
  /** Service-specific settings. */
  [key: string]: unknown;
}

/**
 * Kafka-side settings of the connector, discriminated by
 * `partnerConnectorType`. E.g. `{ authType: "KAFKA_API_KEY", apiKey,
 * apiSecret, topics: ["orders"], inputFormat: "JSON", outputFormat: "JSON",
 * maxTasks: "1" }`.
 */
export interface PartnerConnectorInfo {
  /** The Kafka connector type. */
  partnerConnectorType: PartnerConnectorType;
  /** Partner-specific settings. */
  [key: string]: unknown;
}

export interface ConnectorProps extends OrganizationChildProps {
  /** Environment ID that holds the cluster. Changing it replaces the connector. */
  environment: string;
  /** Cluster ID the connector runs in. Changing it replaces the connector. */
  cluster: string;
  /**
   * Connector name, 1-64 letters, digits, `-`, and `_`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the connector.
   */
  name?: string;
  /** Whether the connector is a sink or a source. Changing it replaces the connector. */
  connectorType: ConnectorType;
  /**
   * Connector class, e.g. `AZUREBLOBSINK` or `AZUREBLOBSOURCE`. Changing it
   * replaces the connector.
   */
  connectorClass: string;
  /**
   * Azure-side target settings. May hold secrets (storage keys, Cosmos DB
   * keys, SQL passwords); they are stored in Alchemy state. Updated in place.
   */
  serviceTypeInfo: ConnectorServiceTypeInfo;
  /**
   * Kafka-side settings (auth, topics, formats). May hold secrets (API
   * secret); they are stored in Alchemy state. Updated in place.
   */
  partnerConnectorInfo: PartnerConnectorInfo;
}

export interface Connector extends Resource<
  "Azure.Confluent.Connector",
  ConnectorProps,
  {
    /** Connector name (ARM resource name). */
    connectorName: string;
    /** Cluster ID the connector runs in. */
    cluster: string;
    /** Environment ID that holds the cluster. */
    environment: string;
    /** Name of the Confluent organization. */
    organization: string;
    /** Resource group of the organization. */
    resourceGroup: string;
    /** ARM resource ID of the connector. */
    connectorResourceId: string;
    /** Connector ID returned by Confluent. */
    connectorId: string | undefined;
    /** Whether the connector is a sink or a source. */
    connectorType: string | undefined;
    /** Connector class, e.g. `AZUREBLOBSINK`. */
    connectorClass: string | undefined;
    /** Connector state, e.g. `RUNNING`. */
    connectorState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A fully managed Kafka Connect connector in a Confluent Cloud cluster of an
 * Azure-managed Confluent organization, moving data between Kafka topics
 * and Azure Blob Storage, Cosmos DB, or Synapse Analytics.
 *
 * Connectors carry no tags, so Alchemy ownership is inherited from the
 * organization's tags. The Azure and Kafka settings are write-only and are
 * re-applied whenever they change.
 *
 * @see https://learn.microsoft.com/azure/partner-solutions/apache-kafka-confluent-cloud/add-connectors
 *
 * ### Creating a Connector
 * **Example:** Sink a topic into Blob Storage
 * ```typescript
 * const connector = yield* Azure.Confluent.Connector("orders-to-blob", {
 *   resourceGroup: org.resourceGroup,
 *   organization: org.organizationName,
 *   environment: environment.environmentId,
 *   cluster: cluster.clusterId,
 *   connectorType: "SINK",
 *   connectorClass: "AZUREBLOBSINK",
 *   serviceTypeInfo: {
 *     connectorServiceType: "AzureBlobStorageSinkConnector",
 *     storageAccountName: account.storageAccountName,
 *     storageAccountKey: storageKey,
 *     storageContainerName: "orders",
 *   },
 *   partnerConnectorInfo: {
 *     partnerConnectorType: "KafkaAzureBlobStorageSink",
 *     authType: "KAFKA_API_KEY",
 *     apiKey,
 *     apiSecret,
 *     topics: ["orders"],
 *     inputFormat: "JSON",
 *     outputFormat: "JSON",
 *     flushSize: "1000",
 *     maxTasks: "1",
 *     timeInterval: "HOURLY",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Connector = Resource<Connector>("Azure.Confluent.Connector");

type ObservedConnector = confluent.GetConnectorResponse;

const createConnectorName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 });

interface ConnectorLocation {
  resourceGroup: string;
  organization: string;
  environment: string;
  cluster: string;
}

const getConnector = (
  subscriptionId: string,
  location: ConnectorLocation,
  connectorName: string,
) =>
  orUndefinedIfNotFound(
    confluent.GetConnector({
      subscriptionId,
      resourceGroupName: location.resourceGroup,
      organizationName: location.organization,
      environmentId: location.environment,
      clusterId: location.cluster,
      connectorName,
    }),
  );

const toAttrs = (
  location: ConnectorLocation,
  name: string,
  observed: ObservedConnector,
): Connector["Attributes"] => {
  const info = observed.properties?.connectorBasicInfo;
  return {
    connectorName: name,
    cluster: location.cluster,
    environment: location.environment,
    organization: location.organization,
    resourceGroup: location.resourceGroup,
    connectorResourceId: observed.id ?? "",
    connectorId: info?.connectorId,
    connectorType: info?.connectorType,
    connectorClass: info?.connectorClass,
    connectorState: info?.connectorState,
  };
};

/** Map the connector state onto ARM provisioning states. */
const connectorState = (connector: ObservedConnector) => {
  const state =
    connector.properties?.connectorBasicInfo?.connectorState?.toUpperCase();
  if (state === undefined || state === "RUNNING" || state === "PAUSED") {
    return "Succeeded";
  }
  if (state === "FAILED") return "Failed";
  return state;
};

const parentChanged = (news: ConnectorLocation, output: ConnectorLocation) =>
  !sameName(news.resourceGroup, output.resourceGroup) ||
  !sameName(news.organization, output.organization) ||
  !sameName(news.environment, output.environment) ||
  !sameName(news.cluster, output.cluster);

export const ConnectorProvider = () =>
  Provider.succeed(Connector, {
    stables: [
      "connectorName",
      "cluster",
      "environment",
      "organization",
      "resourceGroup",
      "connectorResourceId",
    ],

    // Connectors are deleted with their cluster; ownership lives on the
    // organization, which `list` already covers.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const changed = (
        desired: string | undefined,
        observed: string | undefined,
      ) =>
        desired !== undefined &&
        observed !== undefined &&
        !sameName(desired, observed);
      if (
        parentChanged(news, output) ||
        changed(news.name, output.connectorName) ||
        changed(news.connectorType, output.connectorType) ||
        changed(news.connectorClass, output.connectorClass)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const organization = output?.organization ?? olds?.organization;
      const environment = output?.environment ?? olds?.environment;
      const cluster = output?.cluster ?? olds?.cluster;
      if (
        resourceGroup === undefined ||
        organization === undefined ||
        environment === undefined ||
        cluster === undefined
      ) {
        return undefined;
      }
      const location = { resourceGroup, organization, environment, cluster };
      const name =
        output?.connectorName ?? olds?.name ?? (yield* createConnectorName(id));
      const observed = yield* getConnector(subscriptionId, location, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(location, name, observed);
      return (yield* isOrganizationOwnedByStack(
        subscriptionId,
        resourceGroup,
        organization,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Confluent");
      const location: ConnectorLocation = {
        resourceGroup: news.resourceGroup,
        organization: news.organization,
        environment: news.environment,
        cluster: news.cluster,
      };
      const name =
        news.name ?? output?.connectorName ?? (yield* createConnectorName(id));

      // Observe.
      const observed = yield* getConnector(subscriptionId, location, name);

      // Ensure + sync. The service and partner settings carry secrets the
      // GET never returns, so the last applied props are the only baseline
      // for them; a missing connector or changed settings means one PUT.
      const settingsChanged =
        olds === undefined ||
        canonicalJson(olds.serviceTypeInfo) !==
          canonicalJson(news.serviceTypeInfo) ||
        canonicalJson(olds.partnerConnectorInfo) !==
          canonicalJson(news.partnerConnectorInfo);
      if (observed === undefined || settingsChanged) {
        yield* confluent.ConnectorCreateOrUpdate({
          subscriptionId,
          resourceGroupName: location.resourceGroup,
          organizationName: location.organization,
          environmentId: location.environment,
          clusterId: location.cluster,
          connectorName: name,
          properties: {
            connectorBasicInfo: {
              connectorType: news.connectorType,
              connectorClass: news.connectorClass,
              connectorName: name,
            },
            connectorServiceTypeInfo: news.serviceTypeInfo,
            partnerConnectorInfo: news.partnerConnectorInfo,
          },
        });
      }

      const ready = yield* waitForProvisioned(
        `Confluent connector ${name}`,
        getConnector(subscriptionId, location, name),
        connectorState,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(location, name, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        confluent.DeleteConnector({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          organizationName: output.organization,
          environmentId: output.environment,
          clusterId: output.cluster,
          connectorName: output.connectorName,
        }),
      );
      yield* waitUntilGone(
        `Confluent connector ${output.connectorName}`,
        getConnector(subscriptionId, output, output.connectorName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Confluent.Cluster"] },
  });
