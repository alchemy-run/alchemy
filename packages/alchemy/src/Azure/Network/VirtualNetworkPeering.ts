import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  convergeChild,
  createNetworkName,
  parentOwned,
  sameId,
  sameSet,
  waitNetworkGone,
  whileNetworkBusy,
} from "./common.ts";

export interface VirtualNetworkPeeringProps {
  /**
   * Resource group of the local virtual network. Changing it replaces the
   * peering.
   */
  resourceGroup: string;
  /** Name of the local virtual network. Changing it replaces the peering. */
  virtualNetwork: string;
  /**
   * Name of the peering: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the peering.
   */
  name?: string;
  /**
   * ARM ID of the remote virtual network (any region, resource group, or
   * subscription). Changing it replaces the peering.
   */
  remoteVirtualNetworkId: string;
  /**
   * Whether VMs in the local network can reach VMs in the remote network.
   * @default true
   */
  allowVirtualNetworkAccess?: boolean;
  /**
   * Whether traffic forwarded by an appliance in the remote network (not
   * originating in it) is allowed into the local network.
   * @default false
   */
  allowForwardedTraffic?: boolean;
  /**
   * Whether the remote network may use this network's VPN / ExpressRoute
   * gateway.
   * @default false
   */
  allowGatewayTransit?: boolean;
  /**
   * Whether this network uses the remote network's gateway (the remote
   * peering must set `allowGatewayTransit`). Not allowed when this network
   * has its own gateway.
   * @default false
   */
  useRemoteGateways?: boolean;
  /**
   * Skip verifying the provisioning state of the remote gateway.
   * @default false
   */
  doNotVerifyRemoteGateways?: boolean;
  /**
   * Peer the complete address spaces. Set `false` with `localSubnetNames` /
   * `remoteSubnetNames` for subnet-level peering.
   * @default true
   */
  peerCompleteVnets?: boolean;
  /** Local subnets peered when `peerCompleteVnets` is `false`. */
  localSubnetNames?: string[];
  /** Remote subnets peered when `peerCompleteVnets` is `false`. */
  remoteSubnetNames?: string[];
  /**
   * Peer only the IPv6 address space (subnet peering).
   * @default false
   */
  enableOnlyIPv6Peering?: boolean;
}

export interface VirtualNetworkPeering extends Resource<
  "Azure.Network.VirtualNetworkPeering",
  VirtualNetworkPeeringProps,
  {
    /** Name of the peering. */
    peeringName: string;
    /** ARM resource ID of the peering. */
    peeringId: string;
    /** Name of the local virtual network. */
    virtualNetwork: string;
    /** Resource group of the local virtual network. */
    resourceGroup: string;
    /** ARM ID of the remote virtual network. */
    remoteVirtualNetworkId: string;
    /**
     * Peering state: `Initiated` until the reverse peering exists, then
     * `Connected`; `Disconnected` after the reverse peering was deleted.
     */
    peeringState: string | undefined;
    /** Whether the peering is in sync with both address spaces. */
    peeringSyncLevel: string | undefined;
    /** Remote address prefixes peered. */
    remoteAddressPrefixes: string[];
  },
  never,
  Providers
> {}

/**
 * A peering from one Azure virtual network to another. Peerings are
 * directional: connecting two networks takes one peering on each side, and
 * the state reads `Connected` once both exist.
 *
 * When the remote address space changes, the next deploy re-syncs the
 * peering automatically. A peering left `Disconnected` (its counterpart
 * was deleted) is recreated.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-network-peering-overview
 *
 * ### Peering Two Networks
 * **Example:** Bidirectional peering
 * ```typescript
 * const hub = yield* Azure.Network.VirtualNetwork("hub", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const spoke = yield* Azure.Network.VirtualNetwork("spoke", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.1.0.0/16"],
 * });
 * yield* Azure.Network.VirtualNetworkPeering("hub-to-spoke", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: hub.virtualNetworkName,
 *   remoteVirtualNetworkId: spoke.virtualNetworkId,
 * });
 * yield* Azure.Network.VirtualNetworkPeering("spoke-to-hub", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: spoke.virtualNetworkName,
 *   remoteVirtualNetworkId: hub.virtualNetworkId,
 *   allowForwardedTraffic: true,
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkPeering = Resource<VirtualNetworkPeering>(
  "Azure.Network.VirtualNetworkPeering",
);

type Observed = network.GetVirtualNetworkPeeringResponse;

const getPeering = (
  subscriptionId: string,
  resourceGroupName: string,
  virtualNetworkName: string,
  virtualNetworkPeeringName: string,
) =>
  orUndefinedIfNotFound(
    network.GetVirtualNetworkPeering({
      subscriptionId,
      resourceGroupName,
      virtualNetworkName,
      virtualNetworkPeeringName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  virtualNetwork: string,
  name: string,
  peering: Observed,
): VirtualNetworkPeering["Attributes"] => ({
  peeringName: name,
  peeringId: peering.id ?? "",
  virtualNetwork,
  resourceGroup,
  remoteVirtualNetworkId: peering.properties?.remoteVirtualNetwork?.id ?? "",
  peeringState: peering.properties?.peeringState,
  peeringSyncLevel: peering.properties?.peeringSyncLevel,
  remoteAddressPrefixes: [
    ...(peering.properties?.remoteAddressSpace?.addressPrefixes ?? []),
  ],
});

export const VirtualNetworkPeeringProvider = () =>
  Provider.succeed(VirtualNetworkPeering, {
    stables: [
      "peeringName",
      "peeringId",
      "virtualNetwork",
      "resourceGroup",
      "remoteVirtualNetworkId",
    ],

    // Peerings live inside a virtual network; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.virtualNetwork, output.virtualNetwork) ||
        !sameId(news.remoteVirtualNetworkId, output.remoteVirtualNetworkId) ||
        (news.name !== undefined && !sameId(news.name, output.peeringName))
      ) {
        // A VNet holds one peering per remote VNet: delete the old peering first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const virtualNetwork = output?.virtualNetwork ?? olds?.virtualNetwork;
      if (resourceGroup === undefined || virtualNetwork === undefined) {
        return undefined;
      }
      const name =
        output?.peeringName ?? olds?.name ?? (yield* createNetworkName(id));
      const observed = yield* getPeering(
        subscriptionId,
        resourceGroup,
        virtualNetwork,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, virtualNetwork, name, observed);
      const vnet = yield* orUndefinedIfNotFound(
        network.GetVirtualNetwork({
          subscriptionId,
          resourceGroupName: resourceGroup,
          virtualNetworkName: virtualNetwork,
        }),
      );
      return (yield* parentOwned(vnet?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, virtualNetwork } = news;
      const name =
        news.name ?? output?.peeringName ?? (yield* createNetworkName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualNetworkName: virtualNetwork,
        virtualNetworkPeeringName: name,
      };
      const label = `peering ${virtualNetwork}/${name}`;
      const get = getPeering(
        subscriptionId,
        resourceGroup,
        virtualNetwork,
        name,
      );

      // Observe.
      let observed = yield* get;

      // A disconnected peering (its counterpart was deleted) cannot be
      // reconnected in place: Azure requires delete + recreate.
      if (
        observed?.properties?.peeringState === "Disconnected" ||
        (observed !== undefined &&
          !sameId(
            observed.properties?.remoteVirtualNetwork?.id,
            news.remoteVirtualNetworkId,
          ))
      ) {
        yield* ignoreNotFound(network.DeleteVirtualNetworkPeering(where)).pipe(
          Effect.retry(whileNetworkBusy),
        );
        yield* waitNetworkGone(label, get);
        observed = undefined;
      }

      const desired = {
        remoteVirtualNetwork: { id: news.remoteVirtualNetworkId },
        allowVirtualNetworkAccess: news.allowVirtualNetworkAccess ?? true,
        allowForwardedTraffic: news.allowForwardedTraffic ?? false,
        allowGatewayTransit: news.allowGatewayTransit ?? false,
        useRemoteGateways: news.useRemoteGateways ?? false,
        doNotVerifyRemoteGateways: news.doNotVerifyRemoteGateways ?? false,
        peerCompleteVnets: news.peerCompleteVnets ?? true,
        enableOnlyIPv6Peering: news.enableOnlyIPv6Peering ?? false,
        localSubnetNames: news.localSubnetNames,
        remoteSubnetNames: news.remoteSubnetNames,
      };

      // Ensure + sync: one PUT when missing, a flag drifts, or the remote
      // address space changed since the peering last synced.
      const outOfSync = (peering: Observed | undefined) =>
        peering?.properties?.peeringSyncLevel !== undefined &&
        peering.properties.peeringSyncLevel !== "FullyInSync" &&
        peering.properties.peeringState === "Connected";
      const drifted = (peering: Observed | undefined) => {
        const p = peering?.properties;
        return (
          peering === undefined ||
          outOfSync(peering) ||
          (p?.allowVirtualNetworkAccess ?? true) !==
            desired.allowVirtualNetworkAccess ||
          (p?.allowForwardedTraffic ?? false) !==
            desired.allowForwardedTraffic ||
          (p?.allowGatewayTransit ?? false) !== desired.allowGatewayTransit ||
          (p?.useRemoteGateways ?? false) !== desired.useRemoteGateways ||
          (p?.doNotVerifyRemoteGateways ?? false) !==
            desired.doNotVerifyRemoteGateways ||
          (p?.peerCompleteVnets ?? true) !== desired.peerCompleteVnets ||
          (p?.enableOnlyIPv6Peering ?? false) !==
            desired.enableOnlyIPv6Peering ||
          (news.localSubnetNames !== undefined &&
            !sameSet(p?.localSubnetNames, news.localSubnetNames)) ||
          (news.remoteSubnetNames !== undefined &&
            !sameSet(p?.remoteSubnetNames, news.remoteSubnetNames))
        );
      };

      // Ensure + sync: one PUT when missing, a flag drifts, or the remote
      // address space changed since the peering last synced; re-checked
      // after a concurrent VNet update (which re-sends peerings) settles.
      // The peering stays `Initiated` until the reverse peering exists;
      // only provisioning is awaited, not `Connected`.
      observed = yield* convergeChild({
        label,
        get,
        getParent: orUndefinedIfNotFound(
          network.GetVirtualNetwork({
            subscriptionId,
            resourceGroupName: resourceGroup,
            virtualNetworkName: virtualNetwork,
          }),
        ),
        drifted,
        apply: Effect.gen(function* () {
          const current = yield* get;
          yield* network
            .VirtualNetworkPeeringsCreateOrUpdate({
              ...where,
              syncRemoteAddressSpace: outOfSync(current) ? "true" : undefined,
              properties: desired,
            })
            .pipe(Effect.retry(whileNetworkBusy));
        }),
      });
      return toAttrs(resourceGroup, virtualNetwork, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteVirtualNetworkPeering({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          virtualNetworkName: output.virtualNetwork,
          virtualNetworkPeeringName: output.peeringName,
        }),
      ).pipe(Effect.retry(whileNetworkBusy));
      yield* waitNetworkGone(
        `peering ${output.virtualNetwork}/${output.peeringName}`,
        getPeering(
          subscriptionId,
          output.resourceGroup,
          output.virtualNetwork,
          output.peeringName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Network.VirtualNetwork",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
