import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

type TemplateScope = InstanceScope & { readonly akriConnectorTemplateName: string };

export interface AkriConnectorProps {
  /**
   * Resource group of the IoT Operations instance. Changing it replaces the connector.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** IoT Operations instance that holds the template. Changing it replaces the connector. */
  instanceName: string;
  /** Akri connector template the connector runs. Changing it replaces the connector. */
  akriConnectorTemplateName: string;
  /**
   * Connector name (lowercase letters, digits, and hyphens, 3-63
   * characters). If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the connector.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
}

export interface AkriConnector extends Resource<
  "Azure.IoTOperations.AkriConnector",
  AkriConnectorProps,
  {
    /** Name of the connector. */
    akriConnectorName: string;
    /** Akri connector template the connector runs. */
    akriConnectorTemplateName: string;
    /** IoT Operations instance that holds the template. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the connector. */
    akriConnectorId: string;
    /** Provisioning state of the connector. */
    provisioningState: string | undefined;
    /** Health of the connector as reported by the edge cluster. */
    healthState: string | undefined;
    /** Devices (and their inbound endpoints) the cluster assigned to the connector. */
    allocatedDevices: iot.AkriConnectorAllocatedDevice[];
  },
  never,
  Providers
> {}

/**
 * An Akri connector (`Microsoft.IoTOperations/instances/akriConnectorTemplates/connectors`)
 * of an Azure IoT Operations instance: one running connector of an
 * `AkriConnectorTemplate`. The cluster allocates devices to it and
 * reports them in `allocatedDevices`.
 *
 * The connector has no settable configuration: the template holds the
 * image and runtime settings, so the connector is created once and only
 * replaced when its identity changes.
 *
 * :::caution
 * Changing `resourceGroup`, `instanceName`, `akriConnectorTemplateName`, or
 * `name` replaces the connector.
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/iotoperations/akri-connector
 *
 * ### Running a Connector
 * **Example:** A connector of a REST connector template
 * ```typescript
 * const instance = yield* Azure.IoTOperations.Instance("aio", {
 *   customLocationId:
 *     "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/edge/providers/Microsoft.ExtendedLocation/customLocations/aio-location",
 *   schemaRegistryId:
 *     "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/edge/providers/Microsoft.DeviceRegistry/schemaRegistries/aio-schemas",
 * });
 * const template = yield* Azure.IoTOperations.AkriConnectorTemplate("rest", {
 *   instanceName: instance.instanceName,
 *   deviceInboundEndpointTypes: [{ endpointType: "Microsoft.Rest" }],
 *   runtimeConfiguration: {
 *     runtimeConfigurationType: "ManagedConfiguration",
 *     managedConfigurationSettings: {
 *       managedConfigurationType: "ImageConfiguration",
 *       imageConfigurationSettings: {
 *         imageName: "azureiotoperations/akri-connectors/rest",
 *         registrySettings: {
 *           registrySettingsType: "ContainerRegistry",
 *           containerRegistrySettings: { registry: "mcr.microsoft.com" },
 *         },
 *         tagDigestSettings: { tagDigestType: "Tag", tag: "1.0.0" },
 *       },
 *     },
 *   },
 * });
 *
 * const connector = yield* Azure.IoTOperations.AkriConnector("rest-connector", {
 *   instanceName: instance.instanceName,
 *   akriConnectorTemplateName: template.akriConnectorTemplateName,
 * });
 * ```
 *
 * @resource
 */
export const AkriConnector = GroupedResource<AkriConnector>("Azure.IoTOperations.AkriConnector");

export const AkriConnectorProvider = () =>
  Provider.succeed(AkriConnector, {
    stables: [
      "akriConnectorName",
      "akriConnectorTemplateName",
      "instanceName",
      "resourceGroup",
      "akriConnectorId",
    ],
    ...childLifecycle<
      AkriConnectorProps,
      AkriConnector["Attributes"],
      TemplateScope,
      iot.GetAkriConnectorResponse,
      iot.AkriConnectorPropertiesInput
    >({
      kind: "Akri connector",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
        akriConnectorTemplateName: props.akriConnectorTemplateName,
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        akriConnectorTemplateName: attrs.akriConnectorTemplateName,
        name: attrs.akriConnectorName,
      }),
      get: (subscriptionId, key) =>
        iot.GetAkriConnector({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          akriConnectorTemplateName: key.akriConnectorTemplateName,
          connectorName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.AkriConnectorCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          akriConnectorTemplateName: key.akriConnectorTemplateName,
          connectorName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteAkriConnector({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          akriConnectorTemplateName: key.akriConnectorTemplateName,
          connectorName: key.name,
        }),
      // Every connector property is read-only; the PUT carries an empty body.
      bodyOf: () => ({}),
      toAttrs: (key, observed) => ({
        akriConnectorName: key.name,
        akriConnectorTemplateName: key.akriConnectorTemplateName,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        akriConnectorId: observed.id ?? "",
        ...childStatus(observed),
        allocatedDevices: observed.properties?.allocatedDevices ?? [],
      }),
    }),
  });
