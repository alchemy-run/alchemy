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

export interface NetworkTapProps {
  /**
   * Resource group the network tap is created in. Changing it replaces the
   * network tap.
   */
  resourceGroup: string;
  /**
   * Name of the network tap. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the network tap.
   */
  name?: string;
  /**
   * Azure location of the network tap. Changing it replaces the network tap.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the packet broker that mirrors traffic. Changing it replaces
   * the tap.
   */
  networkPacketBrokerId: string;
  /**
   * Where tapped traffic goes: neighbor groups or isolation-domain
   * networks, each with an optional tap rule.
   */
  destinations: mnf.NetworkTapPropertiesInput["destinations"];
  /** How tap rules are refreshed (`Pull` or `Push`). */
  pollingType?: mnf.NetworkTapPropertiesInput["pollingType"];
  /** Free-form description. */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkTap extends Resource<
  "Azure.ManagedNetworkFabric.NetworkTap",
  NetworkTapProps,
  {
    /** Name of the network tap. */
    networkTapName: string;
    /** ARM resource ID of the network tap. */
    networkTapId: string;
    /** Resource group that holds the network tap. */
    resourceGroup: string;
    /** Location of the network tap. */
    location: string;
    /** Source tap rule. */
    sourceTapRuleId: string | undefined;
    /** Description of the network tap. */
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
 * An Azure Operator Nexus network tap — mirrors fabric traffic through a
 * packet broker to neighbor groups or isolation-domain networks, filtered by
 * network tap rules. Needs a Network Fabric with packet broker hardware.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/howto-configure-network-tap
 *
 * ### Creating a Network Tap
 * **Example:** Tap to a neighbor group
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const tap = yield* Azure.ManagedNetworkFabric.NetworkTap("tap", {
 *   resourceGroup: group.resourceGroupName,
 *   // Packet brokers are created with the fabric's hardware.
 *   networkPacketBrokerId: packetBrokerId,
 *   destinations: [
 *     {
 *       name: "collectors",
 *       destinationType: "Direct",
 *       destinationId: collectors.neighborGroupId,
 *       destinationTapRuleId: rule.networkTapRuleId,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const NetworkTap = Resource<NetworkTap>(
  "Azure.ManagedNetworkFabric.NetworkTap",
);

type Observed = mnf.GetNetworkTapResponse;

const getNetworkTap = (
  subscriptionId: string,
  resourceGroupName: string,
  networkTapName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetNetworkTap({ subscriptionId, resourceGroupName, networkTapName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): NetworkTap["Attributes"] => {
  const p = observed.properties;
  return {
    networkTapName: name,
    networkTapId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    sourceTapRuleId: p?.sourceTapRuleId,
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
    tags: userTags(observed.tags),
  };
};

export const NetworkTapProvider = () =>
  Provider.succeed(NetworkTap, {
    stables: ["networkTapName", "networkTapId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListNetworkTapBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNetworkTapBySubscription", page),
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
          !sameArm(news.name, output.networkTapName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          !sameArm(news.networkPacketBrokerId, olds.networkPacketBrokerId))
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
        output?.networkTapName ?? olds?.name ?? (yield* createFabricName(id));
      const observed = yield* getNetworkTap(
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
        news.name ?? output?.networkTapName ?? (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkTapName: name,
      };
      const label = `network tap ${name}`;
      const get = getNetworkTap(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateNetworkTap({
          ...where,
          location,
          tags,
          properties: {
            networkPacketBrokerId: news.networkPacketBrokerId,
            destinations: news.destinations,
            pollingType: news.pollingType,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        destinations: news.destinations,
        pollingType: news.pollingType,
        annotation: news.annotation,
      });
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* mnf.UpdateNetworkTap({
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
        networkTapName: output.networkTapName,
      };
      const label = `network tap ${output.networkTapName}`;
      const get = getNetworkTap(
        subscriptionId,
        output.resourceGroup,
        output.networkTapName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateNetworkTapAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteNetworkTap(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
