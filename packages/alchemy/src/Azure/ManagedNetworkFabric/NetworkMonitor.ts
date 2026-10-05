import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createFabricName,
  differs,
  FABRIC_NAMESPACE,
  propertyDelta,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface NetworkMonitorProps {
  /**
   * Resource group the network monitor is created in. Changing it replaces the
   * network monitor.
   */
  resourceGroup: string;
  /**
   * Name of the network monitor. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the network monitor.
   */
  name?: string;
  /**
   * Azure location of the network monitor. Changing it replaces the network monitor.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * BGP Monitoring Protocol (BMP) station configuration: station address,
   * port, connection mode and properties (required), and monitored networks.
   * The service requires `stationName` to equal the monitor's name, so
   * Alchemy always sets it.
   */
  bmpConfiguration?: mnf.NetworkMonitorPropertiesInput["bmpConfiguration"];
  /**
   * Free-form description. Azure cannot update it in place, so changing
   * it replaces the resource.
   */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkMonitor extends Resource<
  "Azure.ManagedNetworkFabric.NetworkMonitor",
  NetworkMonitorProps,
  {
    /** Name of the network monitor. */
    networkMonitorName: string;
    /** ARM resource ID of the network monitor. */
    networkMonitorId: string;
    /** Resource group that holds the network monitor. */
    resourceGroup: string;
    /** Location of the network monitor. */
    location: string;
    /** Description of the network monitor. */
    annotation: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Configuration state on the fabric devices, e.g. `Succeeded`. */
    configurationState: string | undefined;
    /** Administrative state, e.g. `Enabled` or `Disabled`. */
    administrativeState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus network monitor — a BGP Monitoring Protocol (BMP)
 * station configuration that streams routing state from fabric devices to a
 * collector.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/concepts-network-fabric
 *
 * ### Creating a Network Monitor
 * **Example:** BMP station
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const monitor = yield* Azure.ManagedNetworkFabric.NetworkMonitor("bmp", {
 *   resourceGroup: group.resourceGroupName,
 *   bmpConfiguration: {
 *     stationIp: "10.0.0.10",
 *     stationPort: 5000,
 *     stationConnectionMode: "Active",
 *     stationConnectionProperties: { probeInterval: 60, probeCount: 10 },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const NetworkMonitor = Resource<NetworkMonitor>(
  "Azure.ManagedNetworkFabric.NetworkMonitor",
);

type Observed = mnf.GetNetworkMonitorResponse;

const getNetworkMonitor = (
  subscriptionId: string,
  resourceGroupName: string,
  networkMonitorName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetNetworkMonitor({
      subscriptionId,
      resourceGroupName,
      networkMonitorName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): NetworkMonitor["Attributes"] => {
  const p = observed.properties;
  return {
    networkMonitorName: name,
    networkMonitorId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const NetworkMonitorProvider = () =>
  Provider.succeed(NetworkMonitor, {
    stables: [
      "networkMonitorName",
      "networkMonitorId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListNetworkMonitorBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNetworkMonitorBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.networkMonitorName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined && differs(news.annotation, olds.annotation))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.networkMonitorName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getNetworkMonitor(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.networkMonitorName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkMonitorName: name,
      };
      const label = `network monitor ${name}`;
      const get = getNetworkMonitor(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateNetworkMonitor({
          ...where,
          location,
          tags,
          properties: {
            bmpConfiguration:
              news.bmpConfiguration === undefined
                ? undefined
                : { ...news.bmpConfiguration, stationName: name },
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        bmpConfiguration:
          news.bmpConfiguration === undefined
            ? undefined
            : { ...news.bmpConfiguration, stationName: name },
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateNetworkMonitor({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
        });
        observed = yield* waitFabricProvisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        networkMonitorName: output.networkMonitorName,
      };
      const label = `network monitor ${output.networkMonitorName}`;
      const get = getNetworkMonitor(
        subscriptionId,
        output.resourceGroup,
        output.networkMonitorName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateNetworkMonitorAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteNetworkMonitor(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
