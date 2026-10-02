import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { canonical } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface ConnectionAnalyzerProps {
  /** Resource group of the network watcher. Changing it replaces the analyzer. */
  resourceGroup: string;
  /** Name of the regional network watcher. Changing it replaces the analyzer. */
  networkWatcher: string;
  /**
   * Name of the connection analyzer. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the analyzer.
   */
  name?: string;
  /**
   * Azure location: the watcher's region. Changing it replaces the analyzer.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Source: a VM, VMSS, Bastion host, or Application Gateway
   * (`resourceId`). Changing it replaces the analyzer.
   */
  source: network.ConnectionAnalyzerEndpoint;
  /**
   * Destination: an Azure resource (`resourceId`) or `ExternalAddress`
   * (`address`). Changing it replaces the analyzer.
   */
  destination: network.ConnectionAnalyzerEndpoint;
  /** Diagnostics to run, e.g. `["ConnectivityCheck", "NextHop", "NSG"]`. */
  diagnosticOperations: (
    | "NextHop"
    | "NSG"
    | "PortScan"
    | "ConnectivityCheck"
    | "ExpressRouteDiagnostic"
  )[];
  /** Protocol (and HTTP) settings for connectivity checks. */
  protocolSettings?: network.ProtocolSettings;
  /** Per-diagnostic settings. */
  diagnosticOperationsSettings?: network.DiagnosticOperationsSettings;
  /** Days before the analyzer expires. */
  expiryInDays?: number;
  /** Where results are written. */
  outputSettings?: network.OutputSettings;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface ConnectionAnalyzer extends Resource<
  "Azure.Network.ConnectionAnalyzer",
  ConnectionAnalyzerProps,
  {
    /** Name of the analyzer. */
    connectionAnalyzerName: string;
    /** ARM resource ID of the analyzer. */
    connectionAnalyzerId: string;
    /** Name of the network watcher. */
    networkWatcher: string;
    /** Resource group of the network watcher. */
    resourceGroup: string;
    /** Location of the analyzer. */
    location: string;
    /** Analysis status. */
    status: string | undefined;
    /** Source endpoint. */
    source: network.ConnectionAnalyzerEndpoint | undefined;
    /** Destination endpoint. */
    destination: network.ConnectionAnalyzerEndpoint | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Network Watcher connection analyzer (preview) — a saved set of
 * diagnostics (connectivity check, next hop, NSG evaluation, port scan)
 * between a source Azure resource and a destination.
 *
 * @see https://learn.microsoft.com/azure/network-watcher/network-watcher-overview
 *
 * ### Analyzing a Connection
 * **Example:** Can a VM reach a website?
 * ```typescript
 * yield* Azure.Network.ConnectionAnalyzer("vm-to-web", {
 *   resourceGroup: "NetworkWatcherRG",
 *   networkWatcher: "NetworkWatcher_eastus",
 *   location: "eastus",
 *   source: { type: "VM", resourceId: vm.virtualMachineId },
 *   destination: { type: "ExternalAddress", address: "www.bing.com", port: 443 },
 *   diagnosticOperations: ["ConnectivityCheck", "NextHop"],
 * });
 * ```
 *
 * @resource
 */
export const ConnectionAnalyzer = Resource<ConnectionAnalyzer>(
  "Azure.Network.ConnectionAnalyzer",
);

export const ConnectionAnalyzerProvider = () =>
  Provider.succeed(
    ConnectionAnalyzer,
    networkProvider<ConnectionAnalyzer>()({
      label: "connection analyzer",
      nameAttr: "connectionAnalyzerName",
      parents: ["networkWatcher"],
      tracked: true,
      immutable: (news, output) =>
        canonical(news.source) !== canonical(output.source) ||
        canonical(news.destination) !== canonical(output.destination),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkWatchersConnectionAnalyzer({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkWatcherName: path.networkWatcher!,
            connectionAnalyzerName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.CreateNetworkWatchersConnectionAnalyzer({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.networkWatcher!,
          connectionAnalyzerName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkWatchersConnectionAnalyzer({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.networkWatcher!,
          connectionAnalyzerName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.NetworkWatchersConnectionAnalyzersUpdateTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.networkWatcher!,
          connectionAnalyzerName: path.name,
          tags,
        }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          source: news.source,
          destination: news.destination,
          diagnosticOperations: news.diagnosticOperations,
          protocolSettings: news.protocolSettings,
          diagnosticOperationsSettings: news.diagnosticOperationsSettings,
          expiryInDays: news.expiryInDays,
          outputSettings: news.outputSettings,
        },
      }),
      toAttrs: (path, observed) => ({
        connectionAnalyzerName: path.name,
        connectionAnalyzerId: observed.id ?? "",
        networkWatcher: path.networkWatcher!,
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        status: observed.properties?.status,
        source: observed.properties?.source,
        destination: observed.properties?.destination,
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.NetworkWatcher"],
    }),
  );
