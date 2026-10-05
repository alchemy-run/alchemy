import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

export interface AkriConnectorTemplateProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the template. */
  resourceGroup: string;
  /** IoT Operations instance that holds the template. Changing it replaces the template. */
  instanceName: string;
  /**
   * Template name (lowercase letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the template.
   */
  name?: string;
  /**
   * How connector pods run: `{ runtimeConfigurationType:
   * "ManagedConfiguration", managedConfigurationSettings: {
   * managedConfigurationType: "ImageConfiguration", imageConfigurationSettings:
   * { imageName, registrySettings, tagDigestSettings, replicas? }, allocation?,
   * persistentVolumeClaims?, additionalConfiguration?, secrets? } }`.
   */
  runtimeConfiguration: iot.AkriConnectorTemplateRuntimeConfiguration;
  /** Device inbound endpoint types the connector handles (e.g. `Microsoft.Rest`). */
  deviceInboundEndpointTypes: iot.AkriConnectorTemplateDeviceInboundEndpointType[];
  /** Minimum and maximum IoT Operations versions the connector supports. */
  aioMetadata?: iot.AkriConnectorTemplateAioMetadata;
  /** Log level of the connector. */
  diagnostics?: iot.AkriConnectorTemplateDiagnostics;
  /** How connector pods connect to the MQTT broker. */
  mqttConnectionConfiguration?: iot.AkriConnectorsMqttConnectionConfiguration;
  /** Reference to a connector metadata document in a container registry. */
  connectorMetadataRef?: string;
}

export interface AkriConnectorTemplate extends Resource<
  "Azure.IoTOperations.AkriConnectorTemplate",
  AkriConnectorTemplateProps,
  {
    /** Name of the template. */
    akriConnectorTemplateName: string;
    /** IoT Operations instance that holds the template. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the template. */
    akriConnectorTemplateId: string;
    /** Provisioning state of the template. */
    provisioningState: string | undefined;
    /** Health of the template as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Akri connector template of an Azure IoT Operations instance: the
 * container image and runtime settings of a connector that discovers and
 * talks to devices (REST, ONVIF, media, SSE, ...).
 *
 * @see https://learn.microsoft.com/azure/iot-operations/discover-manage-assets/overview-akri
 *
 * ### Registering a Connector
 * **Example:** REST connector from Microsoft Container Registry
 * ```typescript
 * const template = yield* Azure.IoTOperations.AkriConnectorTemplate("rest", {
 *   resourceGroup: group.resourceGroupName,
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
 * ```
 *
 * @resource
 */
export const AkriConnectorTemplate = Resource<AkriConnectorTemplate>(
  "Azure.IoTOperations.AkriConnectorTemplate",
);

export const AkriConnectorTemplateProvider = () =>
  Provider.succeed(AkriConnectorTemplate, {
    stables: [
      "akriConnectorTemplateName",
      "instanceName",
      "resourceGroup",
      "akriConnectorTemplateId",
    ],
    ...childLifecycle<
      AkriConnectorTemplateProps,
      AkriConnectorTemplate["Attributes"],
      InstanceScope,
      iot.GetAkriConnectorTemplateResponse,
      iot.AkriConnectorTemplatePropertiesInput
    >({
      kind: "Akri connector template",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        name: attrs.akriConnectorTemplateName,
      }),
      get: (subscriptionId, key) =>
        iot.GetAkriConnectorTemplate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          akriConnectorTemplateName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.AkriConnectorTemplateCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          akriConnectorTemplateName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteAkriConnectorTemplate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          akriConnectorTemplateName: key.name,
        }),
      bodyOf: (props) => ({
        runtimeConfiguration: props.runtimeConfiguration,
        deviceInboundEndpointTypes: props.deviceInboundEndpointTypes,
        aioMetadata: props.aioMetadata,
        diagnostics: props.diagnostics,
        mqttConnectionConfiguration: props.mqttConnectionConfiguration,
        connectorMetadataRef: props.connectorMetadataRef,
      }),
      toAttrs: (key, observed) => ({
        akriConnectorTemplateName: key.name,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        akriConnectorTemplateId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
