import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { childLifecycle, type InstanceScope } from "./Common.ts";

export interface AkriServiceProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the service. */
  resourceGroup: string;
  /** IoT Operations instance that holds the service. Changing it replaces the service. */
  instanceName: string;
  /**
   * Service name (lowercase letters, digits, and hyphens, 3-63
   * characters). If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the service.
   */
  name?: string;
}

export interface AkriService extends Resource<
  "Azure.IoTOperations.AkriService",
  AkriServiceProps,
  {
    /** Name of the Akri service. */
    akriServiceName: string;
    /** IoT Operations instance that holds the service. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the Akri service. */
    akriServiceId: string;
    /** Provisioning state of the Akri service. */
    provisioningState: string | undefined;
    /** Health of the Akri service as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Akri service (`Microsoft.IoTOperations/instances/akriServices`) of an
 * Azure IoT Operations instance: the Akri discovery and connector runtime
 * that runs `AkriConnectorTemplate`s on the edge cluster.
 *
 * The service has no settable configuration, so it is created once and
 * only replaced when its identity changes. Its health comes from the
 * cluster.
 *
 * :::caution
 * Changing `resourceGroup`, `instanceName`, or `name` replaces the service.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/iotoperations/akri-service
 *
 * ### Creating an Akri Service
 * **Example:** Akri service of an instance
 * ```typescript
 * const akri = yield* Azure.IoTOperations.AkriService("akri", {
 *   instanceName: instance.instanceName,
 * });
 * ```
 *
 * @resource
 */
export const AkriService = GroupedResource<AkriService>("Azure.IoTOperations.AkriService");

export const AkriServiceProvider = () =>
  Provider.succeed(AkriService, {
    stables: ["akriServiceName", "instanceName", "resourceGroup", "akriServiceId"],
    ...childLifecycle<
      AkriServiceProps,
      AkriService["Attributes"],
      InstanceScope,
      iot.GetAkriServiceResponse,
      iot.AkriServicePropertiesInput
    >({
      kind: "Akri service",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        name: attrs.akriServiceName,
      }),
      get: (subscriptionId, key) =>
        iot.GetAkriService({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          akriServiceName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.AkriServiceCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          akriServiceName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteAkriService({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          akriServiceName: key.name,
        }),
      // Every service property is read-only; the PUT carries an empty body.
      bodyOf: () => ({}),
      toAttrs: (key, observed) => ({
        akriServiceName: key.name,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        akriServiceId: observed.id ?? "",
        provisioningState: observed.properties?.provisioningState,
        // The service reports health only under `status.healthState`.
        healthState: observed.properties?.status?.healthState?.status,
      }),
    }),
  });
