import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

export interface BrokerProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the broker. */
  resourceGroup: string;
  /** IoT Operations instance that holds the broker. Changing it replaces the broker. */
  instanceName: string;
  /**
   * Broker name. IoT Operations currently supports a single broker named
   * `default`. Changing it replaces the broker.
   * @default "default"
   */
  name?: string;
  /** Advanced settings (client limits, internal certificates, encryption of internal traffic). */
  advanced?: iot.AdvancedSettings;
  /** Frontend and backend chain topology. Changing it replaces the broker. */
  cardinality?: iot.Cardinality;
  /** Logs, metrics, self-check, and traces settings. */
  diagnostics?: iot.BrokerDiagnostics;
  /** Disk-backed message buffer settings. Changing it replaces the broker. */
  diskBackedMessageBuffer?: iot.DiskBackedMessageBuffer;
  /** Whether Kubernetes CPU resource limits are requested. Changing it replaces the broker. */
  generateResourceLimits?: iot.GenerateResourceLimits;
  /**
   * Whether high-priority messages are still accepted while regular
   * messages are backpressured.
   * @default "Accept"
   */
  highPriorityMessagesBackpressureHandling?: "Accept" | "Reject";
  /** Memory profile of the broker. Changing it replaces the broker. */
  memoryProfile?: "Tiny" | "Low" | "Medium" | "High";
  /** Persistence settings of the broker. Changing it replaces the broker. */
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
 * The MQTT broker of an Azure IoT Operations instance. IoT Operations
 * deploys one broker named `default`; its topology (cardinality, memory
 * profile, persistence) is fixed at creation, so changing it replaces the
 * broker.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/manage-mqtt-broker/overview-broker
 *
 * ### Configuring the Broker
 * **Example:** Default broker with a low memory profile
 * ```typescript
 * const broker = yield* Azure.IoTOperations.Broker("broker", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   memoryProfile: "Low",
 *   cardinality: {
 *     backendChain: { partitions: 1, redundancyFactor: 1, workers: 1 },
 *     frontend: { replicas: 1, workers: 1 },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Broker = Resource<Broker>("Azure.IoTOperations.Broker");

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
        highPriorityMessagesBackpressureHandling:
          props.highPriorityMessagesBackpressureHandling,
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
