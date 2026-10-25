import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

export interface DataflowProfileProps {
  /**
   * Resource group of the IoT Operations instance. Changing it replaces the profile.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /** IoT Operations instance that holds the profile. Changing it replaces the profile. */
  instanceName: string;
  /**
   * Profile name (lowercase letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. IoT
   * Operations creates a profile named `default`. Changing it replaces the
   * profile.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Number of dataflow runtime instances (1-20) the profile scales to.
   * @default 1
   */
  instanceCount?: number;
  /**
   * Log level and Prometheus metrics port of the dataflow runtime.
   * @default Azure's defaults
   */
  diagnostics?: iot.ProfileDiagnostics;
}

export interface DataflowProfile extends Resource<
  "Azure.IoTOperations.DataflowProfile",
  DataflowProfileProps,
  {
    /** Name of the profile. */
    dataflowProfileName: string;
    /** IoT Operations instance that holds the profile. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the profile. */
    dataflowProfileId: string;
    /** Provisioning state of the profile. */
    provisioningState: string | undefined;
    /** Health of the profile as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A dataflow profile of an Azure IoT Operations instance
 * (`Microsoft.IoTOperations/instances/dataflowProfiles`): the scaling and
 * diagnostics settings of the runtime that executes its dataflows and
 * dataflow graphs.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/connect-to-cloud/howto-configure-dataflow-profile
 *
 * ### Creating a Profile
 * **Example:** Profile with two runtime instances
 * ```typescript
 * const instance = yield* Azure.IoTOperations.Instance("aio", {
 *   customLocationId:
 *     "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/edge/providers/Microsoft.ExtendedLocation/customLocations/aio-location",
 *   schemaRegistryId:
 *     "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/edge/providers/Microsoft.DeviceRegistry/schemaRegistries/aio-schemas",
 * });
 * const profile = yield* Azure.IoTOperations.DataflowProfile("profile", {
 *   instanceName: instance.instanceName,
 *   instanceCount: 2,
 *   diagnostics: { logs: { level: "info" } },
 * });
 * ```
 *
 * :::caution
 * Changing `resourceGroup`, `instanceName`, or `name` replaces the
 * profile.
 * :::
 *
 * @resource
 */
export const DataflowProfile = GroupedResource<DataflowProfile>(
  "Azure.IoTOperations.DataflowProfile",
);

export const DataflowProfileProvider = () =>
  Provider.succeed(DataflowProfile, {
    stables: ["dataflowProfileName", "instanceName", "resourceGroup", "dataflowProfileId"],
    ...childLifecycle<
      DataflowProfileProps,
      DataflowProfile["Attributes"],
      InstanceScope,
      iot.GetDataflowProfileResponse,
      iot.DataflowProfilePropertiesInput
    >({
      kind: "dataflow profile",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        name: attrs.dataflowProfileName,
      }),
      get: (subscriptionId, key) =>
        iot.GetDataflowProfile({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowProfileName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.DataflowProfileCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowProfileName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteDataflowProfile({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowProfileName: key.name,
        }),
      bodyOf: (props) => ({
        instanceCount: props.instanceCount,
        diagnostics: props.diagnostics,
      }),
      toAttrs: (key, observed) => ({
        dataflowProfileName: key.name,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        dataflowProfileId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
