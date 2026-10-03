import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

type BrokerScope = InstanceScope & { readonly brokerName: string };

export interface BrokerAuthenticationProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the authentication. */
  resourceGroup: string;
  /** IoT Operations instance that holds the broker. Changing it replaces the authentication. */
  instanceName: string;
  /**
   * Broker the authentication belongs to. Changing it replaces the authentication.
   * @default "default"
   */
  brokerName?: string;
  /**
   * Authentication name (lowercase letters, digits, and hyphens). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the authentication.
   */
  name?: string;
  /**
   * Authentication methods offered to broker listeners that reference this
   * resource: `ServiceAccountToken` (Kubernetes SAT audiences), `X509`
   * (trusted client CA), or `Custom` (an external authentication server).
   */
  authenticationMethods: iot.BrokerAuthenticatorMethods[];
}

export interface BrokerAuthentication extends Resource<
  "Azure.IoTOperations.BrokerAuthentication",
  BrokerAuthenticationProps,
  {
    /** Name of the authentication. */
    authenticationName: string;
    /** Broker the authentication belongs to. */
    brokerName: string;
    /** IoT Operations instance that holds the broker. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the authentication. */
    authenticationId: string;
    /** Provisioning state of the authentication. */
    provisioningState: string | undefined;
    /** Health of the authentication as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Client authentication policy of an Azure IoT Operations MQTT broker.
 * Broker listener ports reference it by name via `authenticationRef`.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/manage-mqtt-broker/howto-configure-authentication
 *
 * ### Authenticating Clients
 * **Example:** Kubernetes service account tokens
 * ```typescript
 * const authn = yield* Azure.IoTOperations.BrokerAuthentication("sat", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   authenticationMethods: [
 *     {
 *       method: "ServiceAccountToken",
 *       serviceAccountTokenSettings: { audiences: ["aio-internal"] },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** X.509 client certificates
 * ```typescript
 * const authn = yield* Azure.IoTOperations.BrokerAuthentication("x509", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   authenticationMethods: [
 *     {
 *       method: "X509",
 *       x509Settings: { trustedClientCaCert: "client-ca" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const BrokerAuthentication = Resource<BrokerAuthentication>(
  "Azure.IoTOperations.BrokerAuthentication",
);

export const BrokerAuthenticationProvider = () =>
  Provider.succeed(BrokerAuthentication, {
    stables: [
      "authenticationName",
      "brokerName",
      "instanceName",
      "resourceGroup",
      "authenticationId",
    ],
    ...childLifecycle<
      BrokerAuthenticationProps,
      BrokerAuthentication["Attributes"],
      BrokerScope,
      iot.GetBrokerAuthenticationResponse,
      iot.BrokerAuthenticationPropertiesInput
    >({
      kind: "broker authentication",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
        brokerName: props.brokerName ?? "default",
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        brokerName: attrs.brokerName,
        name: attrs.authenticationName,
      }),
      get: (subscriptionId, key) =>
        iot.GetBrokerAuthentication({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.brokerName,
          authenticationName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.BrokerAuthenticationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.brokerName,
          authenticationName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteBrokerAuthentication({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.brokerName,
          authenticationName: key.name,
        }),
      bodyOf: (props) => ({
        authenticationMethods: props.authenticationMethods,
      }),
      toAttrs: (key, observed) => ({
        authenticationName: key.name,
        brokerName: key.brokerName,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        authenticationId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
