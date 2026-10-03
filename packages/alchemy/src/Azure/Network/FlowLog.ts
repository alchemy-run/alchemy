import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface FlowLogProps {
  /**
   * Resource group of the network watcher (Azure-created watchers live in
   * `NetworkWatcherRG`). Changing it replaces the flow log.
   */
  resourceGroup: string;
  /**
   * Name of the regional network watcher, e.g. `NetworkWatcher_eastus`.
   * Changing it replaces the flow log.
   */
  networkWatcher: string;
  /**
   * Name of the flow log. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the flow log.
   */
  name?: string;
  /**
   * Azure location: the watcher's (and target's) region. Changing it
   * replaces the flow log.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the virtual network, subnet, or NIC whose flows are logged
   * (NSG flow logs are retired). Changing it replaces the flow log.
   */
  targetResourceId: string;
  /** ARM ID of the storage account (same region) receiving the logs. */
  storageId: string;
  /** Whether logging is enabled. @default true */
  enabled?: boolean;
  /** Days to retain logs (0 = forever). @default 0 */
  retentionDays?: number;
  /** Log format version (1 or 2). @default 2 */
  formatVersion?: number;
  /** Traffic analytics settings. */
  flowAnalyticsConfiguration?: network.TrafficAnalyticsProperties_7;
  /** Optional filter expression for the logged flows. */
  enabledFilteringCriteria?: string;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface FlowLog extends Resource<
  "Azure.Network.FlowLog",
  FlowLogProps,
  {
    /** Name of the flow log. */
    flowLogName: string;
    /** ARM resource ID of the flow log. */
    flowLogId: string;
    /** Name of the network watcher. */
    networkWatcher: string;
    /** Resource group of the network watcher. */
    resourceGroup: string;
    /** Location of the flow log. */
    location: string;
    /** ARM ID of the logged resource. */
    targetResourceId: string;
    /** ARM ID of the storage account. */
    storageId: string;
    /** Whether logging is enabled. */
    enabled: boolean;
    /** Retention in days. */
    retentionDays: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure virtual network flow log — records IP flows through a virtual
 * network, subnet, or NIC to a storage account (and optionally Traffic
 * Analytics). It lives on the region's {@link NetworkWatcher}. Bills per
 * GB of logs collected (~$0.50/GB) plus storage.
 *
 * @see https://learn.microsoft.com/azure/network-watcher/vnet-flow-logs-overview
 *
 * ### Logging a Virtual Network
 * **Example:** VNet flow log on the Azure-created watcher
 * ```typescript
 * yield* Azure.Network.FlowLog("vnet", {
 *   resourceGroup: "NetworkWatcherRG",
 *   networkWatcher: "NetworkWatcher_eastus",
 *   targetResourceId: vnet.virtualNetworkId,
 *   storageId: account.storageAccountId,
 *   retentionDays: 7,
 * });
 * ```
 *
 * @resource
 */
export const FlowLog = Resource<FlowLog>("Azure.Network.FlowLog");

export const FlowLogProvider = () =>
  Provider.succeed(
    FlowLog,
    networkProvider<FlowLog>()({
      label: "flow log",
      nameAttr: "flowLogName",
      parents: ["networkWatcher"],
      tracked: true,
      immutable: (news, output) =>
        !sameId(news.targetResourceId, output.targetResourceId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetFlowLog({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkWatcherName: path.networkWatcher!,
            flowLogName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.FlowLogsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.networkWatcher!,
          flowLogName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteFlowLog({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.networkWatcher!,
          flowLogName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateFlowLogTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.networkWatcher!,
          flowLogName: path.name,
          tags,
        }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          targetResourceId: news.targetResourceId,
          storageId: news.storageId,
          enabled: news.enabled ?? true,
          enabledFilteringCriteria: news.enabledFilteringCriteria,
          retentionPolicy: {
            days: news.retentionDays ?? 0,
            enabled: (news.retentionDays ?? 0) > 0,
          },
          format: { type: "JSON", version: news.formatVersion ?? 2 },
          flowAnalyticsConfiguration: news.flowAnalyticsConfiguration,
        },
      }),
      toAttrs: (path, observed) => ({
        flowLogName: path.name,
        flowLogId: observed.id ?? "",
        networkWatcher: path.networkWatcher!,
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        targetResourceId: observed.properties?.targetResourceId ?? "",
        storageId: observed.properties?.storageId ?? "",
        enabled: observed.properties?.enabled ?? false,
        retentionDays: observed.properties?.retentionPolicy?.days,
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.NetworkWatcher"],
    }),
  );
