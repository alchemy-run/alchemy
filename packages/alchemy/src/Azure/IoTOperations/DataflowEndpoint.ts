import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

export interface DataflowEndpointProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** IoT Operations instance that holds the endpoint. Changing it replaces the endpoint. */
  instanceName: string;
  /**
   * Endpoint name (lowercase letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the endpoint.
   */
  name?: string;
  /**
   * Endpoint type; set the matching `*Settings` field. Changing it replaces
   * the endpoint.
   */
  endpointType:
    | "DataExplorer"
    | "DataLakeStorage"
    | "FabricOneLake"
    | "Kafka"
    | "LocalStorage"
    | "Mqtt"
    | "OpenTelemetry";
  /** Kind of host behind a Kafka or MQTT endpoint (e.g. `Eventhub`, `EventGrid`, `LocalBroker`). */
  hostType?:
    | "FabricRT"
    | "EventGrid"
    | "LocalBroker"
    | "Eventhub"
    | "CustomMqtt"
    | "CustomKafka";
  /** Azure Data Explorer settings (`endpointType: "DataExplorer"`). */
  dataExplorerSettings?: iot.DataflowEndpointDataExplorer;
  /** Azure Data Lake Storage Gen2 settings (`endpointType: "DataLakeStorage"`). */
  dataLakeStorageSettings?: iot.DataflowEndpointDataLakeStorage;
  /** Microsoft Fabric OneLake settings (`endpointType: "FabricOneLake"`). */
  fabricOneLakeSettings?: iot.DataflowEndpointFabricOneLake;
  /** Kafka settings, incl. Event Hubs (`endpointType: "Kafka"`). */
  kafkaSettings?: iot.DataflowEndpointKafka;
  /** Local persistent volume settings (`endpointType: "LocalStorage"`). */
  localStorageSettings?: iot.DataflowEndpointLocalStorage;
  /** MQTT broker settings, incl. Event Grid (`endpointType: "Mqtt"`). */
  mqttSettings?: iot.DataflowEndpointMqtt;
  /** OpenTelemetry collector settings (`endpointType: "OpenTelemetry"`). */
  openTelemetrySettings?: iot.DataflowEndpointOpenTelemetry;
}

export interface DataflowEndpoint extends Resource<
  "Azure.IoTOperations.DataflowEndpoint",
  DataflowEndpointProps,
  {
    /** Name of the endpoint. */
    dataflowEndpointName: string;
    /** IoT Operations instance that holds the endpoint. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the endpoint. */
    dataflowEndpointId: string;
    /** Provisioning state of the endpoint. */
    provisioningState: string | undefined;
    /** Health of the endpoint as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A dataflow endpoint of an Azure IoT Operations instance: a source or
 * destination (MQTT broker, Kafka/Event Hubs, Data Lake Storage, Data
 * Explorer, Fabric OneLake, local storage, OpenTelemetry) that dataflows
 * reference by name.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/connect-to-cloud/howto-configure-dataflow-endpoint
 *
 * ### Creating Endpoints
 * **Example:** Local MQTT broker
 * ```typescript
 * const local = yield* Azure.IoTOperations.DataflowEndpoint("local", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   endpointType: "Mqtt",
 *   hostType: "LocalBroker",
 *   mqttSettings: {
 *     host: "aio-broker:18883",
 *     authentication: {
 *       method: "ServiceAccountToken",
 *       serviceAccountTokenSettings: { audience: "aio-internal" },
 *     },
 *     tls: { mode: "Enabled", trustedCaCertificateConfigMapRef: "azure-iot-operations-aio-ca-trust-bundle" },
 *   },
 * });
 * ```
 *
 * **Example:** Azure Data Lake Storage with the instance's managed identity
 * ```typescript
 * const lake = yield* Azure.IoTOperations.DataflowEndpoint("lake", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   endpointType: "DataLakeStorage",
 *   dataLakeStorageSettings: {
 *     host: `https://${account.storageAccountName}.blob.core.windows.net`,
 *     authentication: {
 *       method: "SystemAssignedManagedIdentity",
 *       systemAssignedManagedIdentitySettings: {},
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataflowEndpoint = Resource<DataflowEndpoint>(
  "Azure.IoTOperations.DataflowEndpoint",
);

export const DataflowEndpointProvider = () =>
  Provider.succeed(DataflowEndpoint, {
    stables: [
      "dataflowEndpointName",
      "instanceName",
      "resourceGroup",
      "dataflowEndpointId",
    ],
    ...childLifecycle<
      DataflowEndpointProps,
      DataflowEndpoint["Attributes"],
      InstanceScope,
      iot.GetDataflowEndpointResponse,
      iot.DataflowEndpointPropertiesInput
    >({
      kind: "dataflow endpoint",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        name: attrs.dataflowEndpointName,
      }),
      get: (subscriptionId, key) =>
        iot.GetDataflowEndpoint({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowEndpointName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.DataflowEndpointCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowEndpointName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteDataflowEndpoint({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowEndpointName: key.name,
        }),
      bodyOf: (props) => ({
        endpointType: props.endpointType,
        hostType: props.hostType,
        dataExplorerSettings: props.dataExplorerSettings,
        dataLakeStorageSettings: props.dataLakeStorageSettings,
        fabricOneLakeSettings: props.fabricOneLakeSettings,
        kafkaSettings: props.kafkaSettings,
        localStorageSettings: props.localStorageSettings,
        mqttSettings: props.mqttSettings,
        openTelemetrySettings: props.openTelemetrySettings,
      }),
      immutable: ["endpointType"],
      toAttrs: (key, observed) => ({
        dataflowEndpointName: key.name,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        dataflowEndpointId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
