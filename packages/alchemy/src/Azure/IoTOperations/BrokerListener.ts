import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

type BrokerScope = InstanceScope & { readonly brokerName: string };

export interface BrokerListenerProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the listener. */
  resourceGroup: string;
  /** IoT Operations instance that holds the broker. Changing it replaces the listener. */
  instanceName: string;
  /**
   * Broker the listener belongs to. Changing it replaces the listener.
   * @default "default"
   */
  brokerName?: string;
  /**
   * Listener name (lowercase letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the listener.
   */
  name?: string;
  /** Kubernetes Service name of the listener. Changing it replaces the listener. */
  serviceName?: string;
  /**
   * Kubernetes Service type of the listener. Changing it replaces the listener.
   * @default "ClusterIp"
   */
  serviceType?: "ClusterIp" | "LoadBalancer" | "NodePort";
  /**
   * Ports the listener accepts client connections on, each with its
   * protocol (`Mqtt`/`WebSockets`), optional authentication and
   * authorization references, and TLS settings.
   */
  ports: iot.ListenerPort[];
}

export interface BrokerListener extends Resource<
  "Azure.IoTOperations.BrokerListener",
  BrokerListenerProps,
  {
    /** Name of the listener. */
    listenerName: string;
    /** Broker the listener belongs to. */
    brokerName: string;
    /** IoT Operations instance that holds the broker. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the listener. */
    listenerId: string;
    /** Provisioning state of the listener. */
    provisioningState: string | undefined;
    /** Health of the listener as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A listener of an Azure IoT Operations MQTT broker: a Kubernetes Service
 * exposing one or more ports with their own authentication, authorization,
 * and TLS settings.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/manage-mqtt-broker/howto-configure-brokerlistener
 *
 * ### Exposing the Broker
 * **Example:** Load-balanced listener with automatic TLS
 * ```typescript
 * const listener = yield* Azure.IoTOperations.BrokerListener("external", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   serviceType: "LoadBalancer",
 *   serviceName: "aio-broker-external",
 *   ports: [
 *     {
 *       port: 8883,
 *       authenticationRef: authn.authenticationName,
 *       tls: {
 *         mode: "Automatic",
 *         certManagerCertificateSpec: {
 *           issuerRef: { name: "azure-iot-operations-aio-certificate-issuer", kind: "ClusterIssuer", group: "cert-manager.io" },
 *         },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Unencrypted in-cluster listener
 * ```typescript
 * const listener = yield* Azure.IoTOperations.BrokerListener("internal", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   serviceType: "ClusterIp",
 *   ports: [{ port: 1883 }],
 * });
 * ```
 *
 * @resource
 */
export const BrokerListener = Resource<BrokerListener>(
  "Azure.IoTOperations.BrokerListener",
);

export const BrokerListenerProvider = () =>
  Provider.succeed(BrokerListener, {
    stables: [
      "listenerName",
      "brokerName",
      "instanceName",
      "resourceGroup",
      "listenerId",
    ],
    ...childLifecycle<
      BrokerListenerProps,
      BrokerListener["Attributes"],
      BrokerScope,
      iot.GetBrokerListenerResponse,
      iot.BrokerListenerPropertiesInput
    >({
      kind: "broker listener",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
        brokerName: props.brokerName ?? "default",
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        brokerName: attrs.brokerName,
        name: attrs.listenerName,
      }),
      get: (subscriptionId, key) =>
        iot.GetBrokerListener({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.brokerName,
          listenerName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.BrokerListenerCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.brokerName,
          listenerName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteBrokerListener({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.brokerName,
          listenerName: key.name,
        }),
      bodyOf: (props) => ({
        serviceName: props.serviceName,
        serviceType: props.serviceType,
        ports: props.ports,
      }),
      immutable: ["serviceName", "serviceType"],
      toAttrs: (key, observed) => ({
        listenerName: key.name,
        brokerName: key.brokerName,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        listenerId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
