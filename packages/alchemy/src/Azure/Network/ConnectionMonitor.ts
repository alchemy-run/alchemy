import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";

export interface ConnectionMonitorProps {
  /** Resource group of the network watcher. Changing it replaces the monitor. */
  resourceGroup: string;
  /** Name of the regional network watcher. Changing it replaces the monitor. */
  networkWatcher: string;
  /**
   * Name of the connection monitor. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the monitor.
   */
  name?: string;
  /**
   * Azure location: the watcher's region. Changing it replaces the monitor.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Endpoints (sources are VMs/VMSS with the Network Watcher agent). */
  endpoints: network.ConnectionMonitorEndpoint[];
  /** Test configurations (protocol, frequency, thresholds). */
  testConfigurations: network.ConnectionMonitorTestConfiguration[];
  /** Test groups pairing source and destination endpoints with tests. */
  testGroups: network.ConnectionMonitorTestGroup[];
  /** Outputs, e.g. a Log Analytics workspace. */
  outputs?: network.ConnectionMonitorOutput[];
  /** Notes. */
  notes?: string;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface ConnectionMonitor extends Resource<
  "Azure.Network.ConnectionMonitor",
  ConnectionMonitorProps,
  {
    /** Name of the connection monitor. */
    connectionMonitorName: string;
    /** ARM resource ID of the connection monitor. */
    connectionMonitorId: string;
    /** Name of the network watcher. */
    networkWatcher: string;
    /** Resource group of the network watcher. */
    resourceGroup: string;
    /** Location of the monitor. */
    location: string;
    /** Monitoring status (`Running`, `Stopped`, ...). */
    monitoringStatus: string | undefined;
    /** Names of the test groups. */
    testGroupNames: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Network Watcher connection monitor — continuously tests
 * reachability and latency from Azure VMs (with the Network Watcher agent
 * extension) to other endpoints, reporting to Log Analytics. Bills per
 * test (~$0.30/test/month beyond the free tier) plus Log Analytics.
 *
 * @see https://learn.microsoft.com/azure/network-watcher/connection-monitor-overview
 *
 * ### Monitoring a Connection
 * **Example:** VM to bing.com over HTTPS
 * ```typescript
 * yield* Azure.Network.ConnectionMonitor("web", {
 *   resourceGroup: "NetworkWatcherRG",
 *   networkWatcher: "NetworkWatcher_eastus",
 *   endpoints: [
 *     { name: "vm", type: "AzureVM", resourceId: vm.virtualMachineId },
 *     { name: "bing", type: "ExternalAddress", address: "www.bing.com" },
 *   ],
 *   testConfigurations: [
 *     { name: "https", protocol: "Http", testFrequencySec: 60,
 *       httpConfiguration: { port: 443, preferHTTPS: true } },
 *   ],
 *   testGroups: [
 *     { name: "web", sources: ["vm"], destinations: ["bing"], testConfigurations: ["https"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ConnectionMonitor = Resource<ConnectionMonitor>(
  "Azure.Network.ConnectionMonitor",
);

export const ConnectionMonitorProvider = () =>
  Provider.succeed(
    ConnectionMonitor,
    networkProvider<ConnectionMonitor>()({
      label: "connection monitor",
      nameAttr: "connectionMonitorName",
      parents: ["networkWatcher"],
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetConnectionMonitor({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkWatcherName: path.networkWatcher!,
            connectionMonitorName: path.name,
          }),
        ),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          endpoints: news.endpoints,
          testConfigurations: news.testConfigurations,
          testGroups: news.testGroups,
          outputs: news.outputs,
          notes: news.notes,
        },
      }),
      put: (subscriptionId, path, body) =>
        network.ConnectionMonitorsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.networkWatcher!,
          connectionMonitorName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteConnectionMonitor({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.networkWatcher!,
          connectionMonitorName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateConnectionMonitorTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.networkWatcher!,
          connectionMonitorName: path.name,
          tags,
        }),
      slow: true,
      toAttrs: (path, observed) => ({
        connectionMonitorName: path.name,
        connectionMonitorId: observed.id ?? "",
        networkWatcher: path.networkWatcher!,
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        monitoringStatus: observed.properties?.monitoringStatus,
        testGroupNames: (observed.properties?.testGroups ?? []).map(
          (group) => group.name,
        ),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.NetworkWatcher"],
    }),
  );
