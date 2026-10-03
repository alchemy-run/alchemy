import * as nc from "@distilled.cloud/azure/networkcloud";
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
  createNexusName,
  customLocation,
  differs,
  NEXUS_BUDGET,
  NEXUS_NAMESPACE,
  sameArm,
  waitNexusProvisioned,
} from "./Common.ts";

export interface L3NetworkProps {
  /**
   * Resource group the L3 network is created in. Changing it replaces the
   * L3 network.
   */
  resourceGroup: string;
  /**
   * Name of the L3 network. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the L3 network.
   */
  name?: string;
  /**
   * Azure location of the L3 network; must match the location of the Nexus
   * cluster. Changing it replaces the L3 network.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`).
   * Changing it replaces the L3 network.
   */
  customLocationId: string;
  /**
   * ARM ID of the Network Fabric L3 isolation domain the network maps to.
   * Changing it replaces the L3 network.
   */
  l3IsolationDomainId: string;
  /** VLAN of the network. Changing it replaces the L3 network. */
  vlan: number;
  /**
   * IP allocation type: `IPV4`, `IPV6`, or `DualStack`. Changing it replaces
   * the L3 network.
   * @default "DualStack"
   */
  ipAllocationType?: "IPV4" | "IPV6" | "DualStack";
  /**
   * IPv4 prefix (CIDR) of the network. Required for `IPV4` and `DualStack`.
   * Changing it replaces the L3 network.
   */
  ipv4ConnectedPrefix?: string;
  /**
   * IPv6 prefix (CIDR) of the network. Required for `IPV6` and `DualStack`.
   * Changing it replaces the L3 network.
   */
  ipv6ConnectedPrefix?: string;
  /**
   * Interface name of the network on attached virtual machines. Changing it
   * replaces the L3 network.
   */
  interfaceName?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface L3Network extends Resource<
  "Azure.NetworkCloud.L3Network",
  L3NetworkProps,
  {
    /** Name of the L3 network. */
    l3NetworkName: string;
    /** ARM resource ID of the L3 network. */
    l3NetworkId: string;
    /** Resource group that holds the L3 network. */
    resourceGroup: string;
    /** Location of the L3 network. */
    location: string;
    /** Custom location the L3 network is deployed to. */
    customLocationId: string | undefined;
    /** ARM ID of the L3 isolation domain. */
    l3IsolationDomainId: string;
    /** VLAN of the network. */
    vlan: number;
    /** IP allocation type. */
    ipAllocationType: string | undefined;
    /** IPv4 prefix of the network. */
    ipv4ConnectedPrefix: string | undefined;
    /** IPv6 prefix of the network. */
    ipv6ConnectedPrefix: string | undefined;
    /** Interface name on attached virtual machines. */
    interfaceName: string | undefined;
    /** ARM ID of the Nexus cluster the network is associated with. */
    clusterId: string | undefined;
    /** Detailed status reported by the platform. */
    detailedStatus: string | undefined;
    /** Message describing the detailed status. */
    detailedStatusMessage: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus L3 network — a routed workload network on a
 * Network Fabric L3 isolation domain, used by Nexus virtual machines and
 * Kubernetes clusters. Needs a deployed Operator Nexus cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/quickstarts-tenant-workload-prerequisites
 *
 * ### Creating an L3 Network
 * **Example:** Dual-stack L3 network
 * ```typescript
 * const net = yield* Azure.NetworkCloud.L3Network("l3", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   l3IsolationDomainId: l3Domain.l3IsolationDomainId,
 *   vlan: 1001,
 *   ipAllocationType: "DualStack",
 *   ipv4ConnectedPrefix: "10.10.0.0/24",
 *   ipv6ConnectedPrefix: "fd00:10::/64",
 * });
 * ```
 *
 * @resource
 */
export const L3Network = Resource<L3Network>("Azure.NetworkCloud.L3Network");

type Observed = nc.GetL3NetworkResponse;

const getL3Network = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetL3Network({
      subscriptionId,
      resourceGroupName,
      l3NetworkName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): L3Network["Attributes"] => {
  const p = observed.properties;
  return {
    l3NetworkName: name,
    l3NetworkId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    l3IsolationDomainId: p.l3IsolationDomainId,
    vlan: p.vlan,
    ipAllocationType: p.ipAllocationType,
    ipv4ConnectedPrefix: p.ipv4ConnectedPrefix,
    ipv6ConnectedPrefix: p.ipv6ConnectedPrefix,
    interfaceName: p.interfaceName,
    clusterId: p.clusterId,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const L3NetworkProvider = () =>
  Provider.succeed(L3Network, {
    stables: [
      "l3NetworkName",
      "l3NetworkId",
      "resourceGroup",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListL3NetworkBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListL3NetworkBySubscription", page),
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

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.l3NetworkName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId) ||
        !sameArm(news.l3IsolationDomainId, output.l3IsolationDomainId) ||
        differs(news.vlan, output.vlan) ||
        (news.ipAllocationType !== undefined &&
          !sameArm(news.ipAllocationType, output.ipAllocationType)) ||
        (news.ipv4ConnectedPrefix !== undefined &&
          news.ipv4ConnectedPrefix !== output.ipv4ConnectedPrefix) ||
        (news.ipv6ConnectedPrefix !== undefined &&
          !sameArm(news.ipv6ConnectedPrefix, output.ipv6ConnectedPrefix)) ||
        (news.interfaceName !== undefined &&
          news.interfaceName !== output.interfaceName)
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
        output?.l3NetworkName ?? olds?.name ?? (yield* createNexusName(id, 63));
      const observed = yield* getL3Network(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.l3NetworkName ?? (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        l3NetworkName: name,
      };
      const label = `Nexus L3 network ${name}`;
      const get = getL3Network(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.L3NetworksCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          properties: {
            l3IsolationDomainId: news.l3IsolationDomainId,
            vlan: news.vlan,
            ipAllocationType: news.ipAllocationType,
            ipv4ConnectedPrefix: news.ipv4ConnectedPrefix,
            ipv6ConnectedPrefix: news.ipv6ConnectedPrefix,
            interfaceName: news.interfaceName,
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (tagsChanged) {
        yield* nc.UpdateL3Network({
          ...where,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_BUDGET);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.l3NetworkName;
      yield* ignoreNotFound(
        nc.DeleteL3Network({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          l3NetworkName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus L3 network ${name}`,
        getL3Network(subscriptionId, output.resourceGroup, name),
        NEXUS_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
