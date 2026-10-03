import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

type BrokerScope = InstanceScope & { readonly brokerName: string };

export interface BrokerAuthorizationProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the authorization. */
  resourceGroup: string;
  /** IoT Operations instance that holds the broker. Changing it replaces the authorization. */
  instanceName: string;
  /**
   * Broker the authorization belongs to. Changing it replaces the authorization.
   * @default "default"
   */
  brokerName?: string;
  /**
   * Authorization name (lowercase letters, digits, and hyphens). If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the authorization.
   */
  name?: string;
  /**
   * Authorization policies: an optional decision `cache` and `rules` that
   * grant principals (client IDs, usernames, certificate attributes)
   * `Connect`/`Publish`/`Subscribe` on broker topics and access to state
   * store keys.
   */
  authorizationPolicies: iot.AuthorizationConfig;
}

export interface BrokerAuthorization extends Resource<
  "Azure.IoTOperations.BrokerAuthorization",
  BrokerAuthorizationProps,
  {
    /** Name of the authorization. */
    authorizationName: string;
    /** Broker the authorization belongs to. */
    brokerName: string;
    /** IoT Operations instance that holds the broker. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the authorization. */
    authorizationId: string;
    /** Provisioning state of the authorization. */
    provisioningState: string | undefined;
    /** Health of the authorization as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Client authorization policy of an Azure IoT Operations MQTT broker.
 * Broker listener ports reference it by name via `authorizationRef`.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/manage-mqtt-broker/howto-configure-authorization
 *
 * ### Authorizing Clients
 * **Example:** Allow sensors to publish telemetry
 * ```typescript
 * const authz = yield* Azure.IoTOperations.BrokerAuthorization("sensors", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   authorizationPolicies: {
 *     cache: "Enabled",
 *     rules: [
 *       {
 *         principals: { clientIds: ["sensor-*"] },
 *         brokerResources: [
 *           { method: "Connect" },
 *           { method: "Publish", topics: ["telemetry/#"] },
 *         ],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const BrokerAuthorization = Resource<BrokerAuthorization>(
  "Azure.IoTOperations.BrokerAuthorization",
);

export const BrokerAuthorizationProvider = () =>
  Provider.succeed(BrokerAuthorization, {
    stables: [
      "authorizationName",
      "brokerName",
      "instanceName",
      "resourceGroup",
      "authorizationId",
    ],
    ...childLifecycle<
      BrokerAuthorizationProps,
      BrokerAuthorization["Attributes"],
      BrokerScope,
      iot.GetBrokerAuthorizationResponse,
      iot.BrokerAuthorizationPropertiesInput
    >({
      kind: "broker authorization",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
        brokerName: props.brokerName ?? "default",
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        brokerName: attrs.brokerName,
        name: attrs.authorizationName,
      }),
      get: (subscriptionId, key) =>
        iot.GetBrokerAuthorization({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.brokerName,
          authorizationName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.BrokerAuthorizationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.brokerName,
          authorizationName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteBrokerAuthorization({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          brokerName: key.brokerName,
          authorizationName: key.name,
        }),
      bodyOf: (props) => ({
        authorizationPolicies: props.authorizationPolicies,
      }),
      toAttrs: (key, observed) => ({
        authorizationName: key.name,
        brokerName: key.brokerName,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        authorizationId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
