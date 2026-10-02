import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

type ProfileScope = InstanceScope & { readonly dataflowProfileName: string };

export interface DataflowGraphProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the graph. */
  resourceGroup: string;
  /** IoT Operations instance that holds the profile. Changing it replaces the graph. */
  instanceName: string;
  /**
   * Dataflow profile that runs the graph. Changing it replaces the graph.
   * @default "default"
   */
  dataflowProfileName?: string;
  /**
   * Graph name (lowercase letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the graph.
   */
  name?: string;
  /**
   * Whether the graph runs.
   * @default "Enabled"
   */
  mode?: "Enabled" | "Disabled";
  /** Whether the graph requests disk persistence from the broker. */
  requestDiskPersistence?: "Enabled" | "Disabled";
  /**
   * Nodes of the graph. Each node has a `name` and a `nodeType` plus the
   * matching settings: `sourceSettings` (`Source`: `endpointRef`,
   * `dataSources`), `graphSettings` (`Graph`: `registryEndpointRef`,
   * `artifact`, `configuration`), or `destinationSettings` (`Destination`:
   * `endpointRef`, `dataDestination`).
   */
  nodes: iot.DataflowGraphNode[];
  /** Directed connections between nodes (`from.name` → `to.name`). */
  nodeConnections: iot.DataflowGraphNodeConnection[];
}

export interface DataflowGraph extends Resource<
  "Azure.IoTOperations.DataflowGraph",
  DataflowGraphProps,
  {
    /** Name of the graph. */
    dataflowGraphName: string;
    /** Dataflow profile that runs the graph. */
    dataflowProfileName: string;
    /** IoT Operations instance that holds the profile. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the graph. */
    dataflowGraphId: string;
    /** Provisioning state of the graph. */
    provisioningState: string | undefined;
    /** Health of the graph as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A dataflow graph of an Azure IoT Operations instance: a pipeline of
 * WebAssembly processing nodes, pulled from a registry endpoint, between a
 * source and a destination dataflow endpoint.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/connect-to-cloud/howto-dataflow-graph-wasm
 *
 * ### Building a Graph
 * **Example:** Source → WASM module → destination
 * ```typescript
 * const graph = yield* Azure.IoTOperations.DataflowGraph("graph", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   nodes: [
 *     {
 *       name: "source",
 *       nodeType: "Source",
 *       sourceSettings: { endpointRef: "default", dataSources: ["sensors/#"] },
 *     },
 *     {
 *       name: "transform",
 *       nodeType: "Graph",
 *       graphSettings: {
 *         registryEndpointRef: registry.registryEndpointName,
 *         artifact: "graph-simple:1.0.0",
 *       },
 *     },
 *     {
 *       name: "sink",
 *       nodeType: "Destination",
 *       destinationSettings: { endpointRef: "default", dataDestination: "out" },
 *     },
 *   ],
 *   nodeConnections: [
 *     { from: { name: "source" }, to: { name: "transform" } },
 *     { from: { name: "transform" }, to: { name: "sink" } },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const DataflowGraph = Resource<DataflowGraph>(
  "Azure.IoTOperations.DataflowGraph",
);

export const DataflowGraphProvider = () =>
  Provider.succeed(DataflowGraph, {
    stables: [
      "dataflowGraphName",
      "dataflowProfileName",
      "instanceName",
      "resourceGroup",
      "dataflowGraphId",
    ],
    ...childLifecycle<
      DataflowGraphProps,
      DataflowGraph["Attributes"],
      ProfileScope,
      iot.GetDataflowGraphResponse,
      iot.DataflowGraphPropertiesInput
    >({
      kind: "dataflow graph",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
        dataflowProfileName: props.dataflowProfileName ?? "default",
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        dataflowProfileName: attrs.dataflowProfileName,
        name: attrs.dataflowGraphName,
      }),
      get: (subscriptionId, key) =>
        iot.GetDataflowGraph({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowProfileName: key.dataflowProfileName,
          dataflowGraphName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.DataflowGraphCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowProfileName: key.dataflowProfileName,
          dataflowGraphName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteDataflowGraph({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          dataflowProfileName: key.dataflowProfileName,
          dataflowGraphName: key.name,
        }),
      bodyOf: (props) => ({
        mode: props.mode,
        requestDiskPersistence: props.requestDiskPersistence,
        nodes: props.nodes,
        nodeConnections: props.nodeConnections,
      }),
      toAttrs: (key, observed) => ({
        dataflowGraphName: key.name,
        dataflowProfileName: key.dataflowProfileName,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        dataflowGraphId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
