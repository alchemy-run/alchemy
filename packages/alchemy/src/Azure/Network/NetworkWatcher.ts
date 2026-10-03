import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";

export interface NetworkWatcherProps {
  /** Resource group of the network watcher. Changing it replaces the network watcher. */
  resourceGroup: string;
  /**
   * Name of the network watcher: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the network watcher.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the network watcher.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface NetworkWatcher extends Resource<
  "Azure.Network.NetworkWatcher",
  NetworkWatcherProps,
  {
    /** Name of the network watcher. */
    networkWatcherName: string;
    /** ARM resource ID of the network watcher. */
    networkWatcherId: string;
    /** Resource group of the network watcher. */
    resourceGroup: string;
    /** Location of the network watcher. */
    location: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Network Watcher — the regional instance behind flow logs,
 * connection monitors, packet capture, and connectivity diagnostics. A
 * subscription has at most one watcher per region; Azure creates
 * `NetworkWatcher_<region>` in `NetworkWatcherRG` automatically when the
 * first virtual network of a region is created, so manage a watcher only
 * for regions without one (or adopt the existing one). Watchers are free.
 *
 * @see https://learn.microsoft.com/azure/network-watcher/network-watcher-overview
 *
 * ### Creating a Watcher
 * **Example:** Watcher for a region
 * ```typescript
 * const watcher = yield* Azure.Network.NetworkWatcher("canada", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "canadacentral",
 * });
 * ```
 *
 * @resource
 */
export const NetworkWatcher = Resource<NetworkWatcher>(
  "Azure.Network.NetworkWatcher",
);

export const NetworkWatcherProvider = () =>
  Provider.succeed(
    NetworkWatcher,
    networkProvider<NetworkWatcher>()({
      label: "network watcher",
      nameAttr: "networkWatcherName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkWatcher({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkWatcherName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkWatchersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkWatcher({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateNetworkWatcherTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkWatcherName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListNetworkWatcherAll({ subscriptionId }),
      body: (_news, { location, tags }) => ({ location, tags, properties: {} }),
      drifted: () => false,
      toAttrs: (path, observed) => ({
        networkWatcherName: path.name,
        networkWatcherId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        tags: userTags(observed.tags),
      }),
    }),
  );
