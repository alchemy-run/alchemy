import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  annotationMarker,
  createFabricName,
  differs,
  FABRIC_NAMESPACE,
  propertyDelta,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface InternalNetworkProps {
  /**
   * Resource group the internal network is created in. Changing it replaces the
   * internal network.
   */
  resourceGroup: string;
  /**
   * Name of the parent L3 isolation domain (in the same resource group).
   * Changing it replaces the network.
   */
  l3IsolationDomain: string;
  /**
   * Name of the internal network. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the internal network.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /** VLAN ID of the network (100-4095). Changing it replaces the network. */
  vlanId: number;
  /**
   * Extension flag (`NoExtension` or `NPB`). Changing it replaces the
   * network.
   * @default "NoExtension"
   */
  extension?: mnf.InternalNetworkPropertiesInput["extension"];
  /**
   * Maximum transmission unit (64-9200).
   * @default 1500
   */
  mtu?: number;
  /**
   * Connected IPv4 subnets, e.g. `[{ prefix: "10.0.0.0/24" }]`.
   * @default none
   */
  connectedIPv4Subnets?: mnf.InternalNetworkPropertiesInput["connectedIPv4Subnets"];
  /**
   * Connected IPv6 subnets.
   * @default none
   */
  connectedIPv6Subnets?: mnf.InternalNetworkPropertiesInput["connectedIPv6Subnets"];
  /**
   * Import route policies (IPv4/IPv6 route policy IDs).
   * @default none
   */
  importRoutePolicy?: mnf.InternalNetworkPropertiesInput["importRoutePolicy"];
  /**
   * Export route policies (IPv4/IPv6 route policy IDs).
   * @default none
   */
  exportRoutePolicy?: mnf.InternalNetworkPropertiesInput["exportRoutePolicy"];
  /**
   * ARM ID of the ingress access control list.
   * @default none
   */
  ingressAclId?: string;
  /**
   * ARM ID of the egress access control list.
   * @default none
   */
  egressAclId?: string;
  /**
   * Enable monitoring (`True`/`False`).
   * @default "False"
   */
  isMonitoringEnabled?: mnf.InternalNetworkPropertiesInput["isMonitoringEnabled"];
  /**
   * BGP configuration (peer ASN, neighbors, BFD).
   * @default none
   */
  bgpConfiguration?: mnf.InternalNetworkPropertiesInput["bgpConfiguration"];
  /**
   * Static routes (IPv4/IPv6) and BFD.
   * @default none
   */
  staticRouteConfiguration?: mnf.InternalNetworkPropertiesInput["staticRouteConfiguration"];
  /**
   * Native IPv4 prefix limit.
   * @default none
   */
  nativeIpv4PrefixLimit?: mnf.InternalNetworkPropertiesInput["nativeIpv4PrefixLimit"];
  /**
   * Native IPv6 prefix limit.
   * @default none
   */
  nativeIpv6PrefixLimit?: mnf.InternalNetworkPropertiesInput["nativeIpv6PrefixLimit"];
}

export interface InternalNetwork extends Resource<
  "Azure.ManagedNetworkFabric.InternalNetwork",
  InternalNetworkProps,
  {
    /** Name of the internal network. */
    internalNetworkName: string;
    /** ARM resource ID of the internal network. */
    internalNetworkId: string;
    /** Resource group that holds the internal network. */
    resourceGroup: string;
    /** Name of the parent L3 isolation domain. */
    l3IsolationDomain: string;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** Configuration state on the fabric devices, e.g. `Succeeded`. */
    configurationState: string | undefined;
    /** Administrative state, e.g. `Enabled` or `Disabled`. */
    administrativeState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus internal network — a workload VLAN and subnets
 * inside an L3 isolation domain, with optional BGP/static routing, route
 * policies, and ACLs. Alchemy marks ownership in `properties.annotation`.
 * Needs an Operator Nexus Network Fabric.
 *
 * ARM type: `Microsoft.ManagedNetworkFabric/l3IsolationDomains/internalNetworks`.
 * See the [Azure documentation](https://learn.microsoft.com/azure/operator-nexus/howto-configure-isolation-domain).
 *
 * :::caution
 * Changing `resourceGroup`, `l3IsolationDomain`, `name`, `vlanId`, or
 * `extension` replaces the network.
 * :::
 *
 * ### Creating an Internal Network
 * **Example:** Workload subnet with BGP
 * ```typescript
 * // The Network Fabric is provisioned on Operator Nexus racks.
 * const fabricId =
 *   "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/nexus/providers/Microsoft.ManagedNetworkFabric/networkFabrics/fab1";
 * const l3 = yield* Azure.ManagedNetworkFabric.L3IsolationDomain("tenant", {
 *   networkFabricId: fabricId,
 * });
 * const internal = yield* Azure.ManagedNetworkFabric.InternalNetwork("workload", {
 *   l3IsolationDomain: l3.l3IsolationDomainName,
 *   vlanId: 805,
 *   mtu: 1500,
 *   connectedIPv4Subnets: [{ prefix: "10.1.2.0/24" }],
 *   bgpConfiguration: {
 *     peerASN: 65047,
 *     ipv4ListenRangePrefixes: ["10.1.2.0/28"],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const InternalNetwork = GroupedResource<InternalNetwork>(
  "Azure.ManagedNetworkFabric.InternalNetwork",
);

type Observed = mnf.GetInternalNetworkResponse;

const getInternalNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  l3IsolationDomainName: string,
  internalNetworkName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetInternalNetwork({
      subscriptionId,
      resourceGroupName,
      l3IsolationDomainName,
      internalNetworkName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  l3IsolationDomain: string,
  name: string,
  observed: Observed,
): InternalNetwork["Attributes"] => {
  const p = observed.properties;
  return {
    internalNetworkName: name,
    internalNetworkId: observed.id ?? "",
    resourceGroup,
    l3IsolationDomain,
    provisioningState: p?.provisioningState,
    configurationState: p?.configurationState,
    administrativeState: p?.administrativeState,
  };
};

export const InternalNetworkProvider = () =>
  Provider.succeed(InternalNetwork, {
    stables: ["internalNetworkName", "internalNetworkId", "resourceGroup", "l3IsolationDomain"],

    // Child of L3 isolation domain: deleted together with its parent.
    list: Effect.fn(function* () {
      return [] as InternalNetwork["Attributes"][];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.l3IsolationDomain, output.l3IsolationDomain) ||
        (news.name !== undefined && !sameArm(news.name, output.internalNetworkName)) ||
        (olds !== undefined &&
          (differs(news.vlanId, olds.vlanId) || differs(news.extension, olds.extension)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const parent = output?.l3IsolationDomain ?? olds?.l3IsolationDomain;
      if (resourceGroup === undefined || parent === undefined) return undefined;
      const name = output?.internalNetworkName ?? olds?.name ?? (yield* createFabricName(id));
      const observed = yield* getInternalNetwork(subscriptionId, resourceGroup, parent, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, parent, name, observed);
      return observed.properties?.annotation === (yield* annotationMarker(id))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const parent = news.l3IsolationDomain;
      const name = news.name ?? output?.internalNetworkName ?? (yield* createFabricName(id));
      const annotation = yield* annotationMarker(id);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        l3IsolationDomainName: parent,
        internalNetworkName: name,
      };
      const label = `internal network ${name}`;
      const get = getInternalNetwork(subscriptionId, resourceGroup, parent, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateInternalNetwork({
          ...where,
          properties: {
            vlanId: news.vlanId,
            extension: news.extension,
            mtu: news.mtu,
            connectedIPv4Subnets: news.connectedIPv4Subnets,
            connectedIPv6Subnets: news.connectedIPv6Subnets,
            importRoutePolicy: news.importRoutePolicy,
            exportRoutePolicy: news.exportRoutePolicy,
            ingressAclId: news.ingressAclId,
            egressAclId: news.egressAclId,
            isMonitoringEnabled: news.isMonitoringEnabled,
            bgpConfiguration: news.bgpConfiguration,
            staticRouteConfiguration: news.staticRouteConfiguration,
            nativeIpv4PrefixLimit: news.nativeIpv4PrefixLimit,
            nativeIpv6PrefixLimit: news.nativeIpv6PrefixLimit,
            annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get);

      // Sync mutable aspects against observed state; send only the delta.
      const delta = propertyDelta(observed.properties, {
        mtu: news.mtu,
        connectedIPv4Subnets: news.connectedIPv4Subnets,
        connectedIPv6Subnets: news.connectedIPv6Subnets,
        importRoutePolicy: news.importRoutePolicy,
        exportRoutePolicy: news.exportRoutePolicy,
        ingressAclId: news.ingressAclId,
        egressAclId: news.egressAclId,
        isMonitoringEnabled: news.isMonitoringEnabled,
        bgpConfiguration: news.bgpConfiguration,
        staticRouteConfiguration: news.staticRouteConfiguration,
        nativeIpv4PrefixLimit: news.nativeIpv4PrefixLimit,
        nativeIpv6PrefixLimit: news.nativeIpv6PrefixLimit,
        annotation,
      });
      if (delta !== undefined) {
        yield* mnf.UpdateInternalNetwork({
          ...where,
          properties: delta,
        });
        observed = yield* waitFabricProvisioned(label, get);
      }

      return toAttrs(resourceGroup, parent, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        l3IsolationDomainName: output.l3IsolationDomain,
        internalNetworkName: output.internalNetworkName,
      };
      const label = `internal network ${output.internalNetworkName}`;
      const get = getInternalNetwork(
        subscriptionId,
        output.resourceGroup,
        output.l3IsolationDomain,
        output.internalNetworkName,
      );
      // Fabric-bound resources must be administratively disabled first.
      const current = yield* get;
      if (current?.properties?.administrativeState === "Enabled") {
        yield* mnf.UpdateInternalNetworkAdministrativeState({
          ...where,
          state: "Disable",
        });
        yield* waitFabricProvisioned(label, get);
      }
      yield* ignoreNotFound(mnf.DeleteInternalNetwork(where));
      yield* waitUntilGone(label, get, { interval: "5 seconds", times: 60 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.ManagedNetworkFabric.L3IsolationDomain"],
    },
  });
