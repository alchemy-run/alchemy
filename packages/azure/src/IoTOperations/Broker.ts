import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

export interface BrokerProps {
  /**
   * Resource group of the IoT Operations instance. Changing it replaces the broker.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** IoT Operations instance that holds the broker. Changing it replaces the broker. */
  instanceName: string;
  /**
   * Broker name. IoT Operations currently supports a single broker named
   * `default`. Changing it replaces the broker.
   * @default "default"
   */
  name?: string;
  /**
   * Advanced settings (client limits, internal certificates, encryption of internal traffic).
   * @default Azure's defaults
   */
  advanced?: iot.AdvancedSettings;
  /**
   * Frontend and backend chain topology. Changing it replaces the broker.
   * @default Azure's default topology
   */
  cardinality?: iot.Cardinality;
  /**
   * Logs, metrics, self-check, and traces settings.
   * @default Azure's defaults
   */
  diagnostics?: iot.BrokerDiagnostics;
  /**
   * Disk-backed message buffer settings. Changing it replaces the broker.
   * @default unset
   */
  diskBackedMessageBuffer?: iot.DiskBackedMessageBuffer;
  /**
   * Whether Kubernetes CPU resource limits are requested. Changing it replaces the broker.
   * @default Azure's default
   */
  generateResourceLimits?: iot.GenerateResourceLimits;
  /**
   * Whether high-priority messages are still accepted while regular
   * messages are backpressured.
   * @default "Accept"
   */
  highPriorityMessagesBackpressureHandling?: "Accept" | "Reject";
  /**
   * Memory profile of the broker. Changing it replaces the broker.
   * @default Azure's default
   */
  memoryProfile?: "Tiny" | "Low" | "Medium" | "High";
  /**
   * Persistence settings of the broker. Changing it replaces the broker.
   * @default unset
   */
  persistence?: iot.BrokerPersistence;
}

export interface Broker extends Resource<
  "Azure.IoTOperations.Broker",
  BrokerProps,
  {
    /** Name of the broker. */
    brokerName: string;
    /** IoT Operations instance that holds the broker. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the broker. */
    brokerId: string;
    /** Provisioning state of the broker. */
    provisioningState: string | undefined;
    /** Health of the broker as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The MQTT broker of an Azure IoT Operations instance
 * (`Microsoft.IoTOperations/instances/brokers`). IoT Operations deploys one
 * broker named `default`. Its topology (cardinality, memory profile,
 * persistence) is fixed at creation.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/manage-mqtt-broker/overview-broker
 *
 * ### Configuring the Broker
 * **Example:** Default broker with a low memory profile
 * ```typescript
 * const instance = yield* Azure.IoTOperations.Instance("aio", {
 *   customLocationId:
 *     "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/edge/providers/Microsoft.ExtendedLocation/customLocations/aio-location",
 *   schemaRegistryId:
 *     "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/edge/providers/Microsoft.DeviceRegistry/schemaRegistries/aio-schemas",
 * });
 * const broker = yield* Azure.IoTOperations.Broker("broker", {
 *   instanceName: instance.instanceName,
 *   memoryProfile: "Low",
 *   cardinality: {
 *     backendChain: { partitions: 1, redundancyFactor: 1, workers: 1 },
 *     frontend: { replicas: 1, workers: 1 },
 *   },
 * });
 * ```
 *
 * :::caution
 * Changing `resourceGroup`, `instanceName`, `name`, `cardinality`,
 * `diskBackedMessageBuffer`, `generateResourceLimits`, `memoryProfile`, or
 * `persistence` replaces the broker. The old broker is deleted first, so
 * MQTT clients disconnect.
 * :::
 *
 * @resource
 */
export const Broker = GroupedResource<Broker>("Azure.IoTOperations.Broker");

export const BrokerProvider = () =>
  Provider.succeed(Broker, {
    stables: ["brokerName", "instanceName", "resourceGroup", "brokerId"],
    ...childLifecycle<
      BrokerProps,
      Broker["Attributes"],
      InstanceScope,
      iot.GetBrokerResponse,
      iot.BrokerPropertiesInput
    >({
      kind: "broker",
      defaultName: "default",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        name: attrs.brokerName,
      }),
      get: (subscriptionId, key) =>
        iot.GetBroker({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.BrokerCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteBroker({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.name,
        }),
      bodyOf: (props) => ({
        advanced: props.advanced,
        cardinality: props.cardinality,
        diagnostics: props.diagnostics,
        diskBackedMessageBuffer: props.diskBackedMessageBuffer,
        generateResourceLimits: props.generateResourceLimits,
        highPriorityMessagesBackpressureHandling: props.highPriorityMessagesBackpressureHandling,
        memoryProfile: props.memoryProfile,
        persistence: props.persistence,
      }),
      immutable: [
        "cardinality",
        "memoryProfile",
        "diskBackedMessageBuffer",
        "persistence",
        "generateResourceLimits",
      ],
      toAttrs: (key, observed) => ({
        brokerName: key.name,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        brokerId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
