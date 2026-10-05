import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

type ProfileScope = InstanceScope & { readonly dataflowProfileName: string };

export interface DataflowProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the dataflow. */
  resourceGroup: string;
  /** IoT Operations instance that holds the profile. Changing it replaces the dataflow. */
  instanceName: string;
  /**
   * Dataflow profile that runs the dataflow. Changing it replaces the dataflow.
   * @default "default"
   */
  dataflowProfileName?: string;
  /**
   * Dataflow name (lowercase letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the dataflow.
   */
  name?: string;
  /**
   * Whether the dataflow runs.
   * @default "Enabled"
   */
  mode?: "Enabled" | "Disabled";
  /** Whether the dataflow requests disk persistence from the broker. */
  requestDiskPersistence?: "Enabled" | "Disabled";
  /**
   * Operations of the dataflow: exactly one `Source` (endpoint reference
   * and topics), optional `BuiltInTransformation`s (datasets, filters,
   * maps), and exactly one `Destination` (endpoint reference and target).
   */
  operations: iot.DataflowOperation[];
}

export interface Dataflow extends Resource<
  "Azure.IoTOperations.Dataflow",
  DataflowProps,
  {
    /** Name of the dataflow. */
    dataflowName: string;
    /** Dataflow profile that runs the dataflow. */
    dataflowProfileName: string;
    /** IoT Operations instance that holds the profile. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the dataflow. */
    dataflowId: string;
    /** Provisioning state of the dataflow. */
    provisioningState: string | undefined;
    /** Health of the dataflow as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A dataflow of an Azure IoT Operations instance: routes messages from a
 * source dataflow endpoint, through optional transformations, to a
 * destination dataflow endpoint.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/connect-to-cloud/howto-create-dataflow
 *
 * ### Routing Messages
 * **Example:** Forward broker telemetry to Event Hubs
 * ```typescript
 * const dataflow = yield* Azure.IoTOperations.Dataflow("telemetry", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   operations: [
 *     {
 *       operationType: "Source",
 *       sourceSettings: { endpointRef: "default", dataSources: ["telemetry/#"] },
 *     },
 *     {
 *       operationType: "Destination",
 *       destinationSettings: {
 *         endpointRef: eventHubs.dataflowEndpointName,
 *         dataDestination: "telemetry",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const Dataflow = Resource<Dataflow>("Azure.IoTOperations.Dataflow");

export const DataflowProvider = () =>
  Provider.succeed(Dataflow, {
    stables: [
      "dataflowName",
      "dataflowProfileName",
      "instanceName",
      "resourceGroup",
      "dataflowId",
    ],
    ...childLifecycle<
      DataflowProps,
      Dataflow["Attributes"],
      ProfileScope,
      iot.GetDataflowResponse,
      iot.DataflowPropertiesInput
    >({
      kind: "dataflow",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
        dataflowProfileName: props.dataflowProfileName ?? "default",
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        dataflowProfileName: attrs.dataflowProfileName,
        name: attrs.dataflowName,
      }),
      get: (subscriptionId, key) =>
        iot.GetDataflow({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowProfileName: key.dataflowProfileName,
          dataflowName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.DataflowCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowProfileName: key.dataflowProfileName,
          dataflowName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteDataflow({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowProfileName: key.dataflowProfileName,
          dataflowName: key.name,
        }),
      bodyOf: (props) => ({
        mode: props.mode,
        requestDiskPersistence: props.requestDiskPersistence,
        operations: props.operations,
      }),
      toAttrs: (key, observed) => ({
        dataflowName: key.name,
        dataflowProfileName: key.dataflowProfileName,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        dataflowId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
