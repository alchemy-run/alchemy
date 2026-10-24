import * as network from "@distilled.cloud/azure/network";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { ref, reveal, secretChanged, waitNetworkProvisionedSlow } from "./common.ts";
import { networkProvider, subsetDiffers, type NetworkPath } from "./generic.ts";

/** Microsoft peering settings: the public prefixes and ASN you advertise. */
export interface ExpressRouteMicrosoftPeeringConfig {
  /** Public prefixes advertised over the peering (validated by Microsoft). */
  advertisedPublicPrefixes: string[];
  /** BGP communities advertised over the peering. */
  advertisedCommunities?: string[];
  /** Customer ASN, when the prefixes belong to a customer of yours. */
  customerAsn?: number;
  /** Routing registry that holds the prefixes and ASN, e.g. `"ARIN"`. */
  routingRegistryName?: string;
}

/** IPv6 settings of a peering. */
export interface ExpressRouteCircuitPeeringIpv6 {
  /** /126 IPv6 prefix of the primary link. */
  primaryPeerAddressPrefix: string;
  /** /126 IPv6 prefix of the secondary link. */
  secondaryPeerAddressPrefix: string;
  /**
   * Whether IPv6 peering is on.
   * @default "Enabled"
   */
  state?: "Enabled" | "Disabled";
  /** Microsoft peering settings for IPv6 (Microsoft peering only). */
  microsoftPeering?: ExpressRouteMicrosoftPeeringConfig;
  /** ARM ID of a route filter (Microsoft peering only). */
  routeFilterId?: string;
}

export interface ExpressRouteCircuitPeeringProps {
  /** Resource group of the circuit. Changing it replaces the peering. */
  resourceGroup: string;
  /** Name of the parent circuit. Changing it replaces the peering. */
  circuit: string;
  /**
   * Peering type; Azure names the peering after it, so a circuit has at
   * most one peering of each type. Changing it replaces the peering.
   */
  peeringType: "AzurePrivatePeering" | "MicrosoftPeering";
  /** ASN of your edge routers. */
  peerAsn: number;
  /** /30 IPv4 prefix of the primary link, e.g. `"192.168.10.0/30"`. */
  primaryPeerAddressPrefix: string;
  /** /30 IPv4 prefix of the secondary link, e.g. `"192.168.10.4/30"`. */
  secondaryPeerAddressPrefix: string;
  /** VLAN ID of the peering (unique on the circuit). */
  vlanId: number;
  /**
   * BGP MD5 key. Azure never returns it, so a change is detected against
   * the previous deploy's value.
   */
  sharedKey?: string | Redacted.Redacted<string>;
  /**
   * Whether the peering is on.
   * @default "Enabled"
   */
  state?: "Enabled" | "Disabled";
  /** Microsoft peering settings (`MicrosoftPeering` only). */
  microsoftPeering?: ExpressRouteMicrosoftPeeringConfig;
  /** ARM ID of a route filter (`MicrosoftPeering` only). */
  routeFilterId?: string;
  /** IPv6 settings. */
  ipv6?: ExpressRouteCircuitPeeringIpv6;
}

export interface ExpressRouteCircuitPeering extends Resource<
  "Azure.Network.ExpressRouteCircuitPeering",
  ExpressRouteCircuitPeeringProps,
  {
    /** Name of the peering (its type). */
    peeringName: string;
    /** ARM resource ID of the peering. */
    peeringId: string;
    /** Name of the parent circuit. */
    circuit: string;
    /** Resource group of the circuit. */
    resourceGroup: string;
    /** Peering type. */
    peeringType: string | undefined;
    /** Whether the peering is on. */
    state: string | undefined;
    /** Microsoft's ASN on the peering. */
    azureAsn: number | undefined;
    /** Microsoft port of the primary link. */
    primaryAzurePort: string | undefined;
    /** Microsoft port of the secondary link. */
    secondaryAzurePort: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A BGP peering of an Azure {@link ExpressRouteCircuit}
 * (`Microsoft.Network/expressRouteCircuits/peerings`): private peering to
 * your virtual networks, or Microsoft peering to Microsoft 365 and public
 * Azure services. The circuit must be provisioned by its connectivity
 * provider first; until then Azure rejects the peering. Peerings carry no
 * tags: ownership follows the parent circuit. Peerings are free.
 *
 * :::caution
 * Changing `circuit` or `peeringType` replaces the peering, which drops
 * BGP sessions and the circuit's connections on it.
 * :::
 *
 * @see https://learn.microsoft.com/azure/expressroute/expressroute-howto-routing-portal-resource-manager
 *
 * ### Configuring Private Peering
 * **Example:** Private peering on a provisioned circuit
 * ```typescript
 * const peering = yield* Azure.Network.ExpressRouteCircuitPeering("private", {
 *   circuit: circuit.circuitName,
 *   peeringType: "AzurePrivatePeering",
 *   peerAsn: 65010,
 *   primaryPeerAddressPrefix: "192.168.10.0/30",
 *   secondaryPeerAddressPrefix: "192.168.10.4/30",
 *   vlanId: 100,
 * });
 * ```
 *
 * @resource
 */
export const ExpressRouteCircuitPeering = GroupedResource<ExpressRouteCircuitPeering>(
  "Azure.Network.ExpressRouteCircuitPeering",
);

const getCircuit = (subscriptionId: string, path: NetworkPath) =>
  orUndefinedIfNotFound(
    network.GetExpressRouteCircuit({
      subscriptionId,
      resourceGroupName: path.resourceGroup,
      circuitName: path.circuit!,
    }),
  );

const microsoftConfig = (config: ExpressRouteMicrosoftPeeringConfig | undefined) =>
  config && {
    advertisedPublicPrefixes: config.advertisedPublicPrefixes,
    advertisedCommunities: config.advertisedCommunities,
    customerASN: config.customerAsn,
    routingRegistryName: config.routingRegistryName,
  };

/** Azure names a peering after its type. */
const named = (props: ExpressRouteCircuitPeeringProps): ExpressRouteCircuitPeeringProps =>
  Object.assign({ name: props.peeringType }, props);

export const ExpressRouteCircuitPeeringProvider = () => {
  const base = networkProvider<ExpressRouteCircuitPeering>()({
    label: "ExpressRoute circuit peering",
    nameAttr: "peeringName",
    parents: ["circuit"],
    tracked: false,
    immutable: (news, output) =>
      output.peeringType !== undefined &&
      news.peeringType.toLowerCase() !== output.peeringType.toLowerCase(),
    get: (subscriptionId, path) =>
      orUndefinedIfNotFound(
        network.GetExpressRouteCircuitPeering({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          circuitName: path.circuit!,
          peeringName: path.name,
        }),
      ),
    // The circuit rejects child writes until it finished provisioning.
    body: (news, { observed }) => ({
      properties: {
        peeringType: news.peeringType,
        state: news.state ?? "Enabled",
        peerASN: news.peerAsn,
        primaryPeerAddressPrefix: news.primaryPeerAddressPrefix,
        secondaryPeerAddressPrefix: news.secondaryPeerAddressPrefix,
        vlanId: news.vlanId,
        sharedKey: reveal(news.sharedKey),
        microsoftPeeringConfig: microsoftConfig(news.microsoftPeering),
        routeFilter: ref(news.routeFilterId),
        ipv6PeeringConfig: news.ipv6 && {
          primaryPeerAddressPrefix: news.ipv6.primaryPeerAddressPrefix,
          secondaryPeerAddressPrefix: news.ipv6.secondaryPeerAddressPrefix,
          state: news.ipv6.state ?? "Enabled",
          microsoftPeeringConfig: microsoftConfig(news.ipv6.microsoftPeering),
          routeFilter: ref(news.ipv6.routeFilterId),
        },
        connections: observed?.properties?.connections?.map((c) => ({
          id: c.id,
          name: c.name,
          properties: c.properties,
        })),
      },
    }),
    put: (subscriptionId, path, body) =>
      waitNetworkProvisionedSlow(
        `ExpressRoute circuit ${path.circuit}`,
        getCircuit(subscriptionId, path),
      ).pipe(
        Effect.andThen(
          network.ExpressRouteCircuitPeeringsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            circuitName: path.circuit!,
            peeringName: path.name,
            ...body,
          }),
        ),
      ),
    del: (subscriptionId, path) =>
      network.DeleteExpressRouteCircuitPeering({
        subscriptionId,
        resourceGroupName: path.resourceGroup,
        circuitName: path.circuit!,
        peeringName: path.name,
      }),
    ownerTags: (subscriptionId, path) =>
      getCircuit(subscriptionId, path).pipe(Effect.map((circuit) => circuit?.tags)),
    // The peering PUT replaces its Global Reach connections: re-send the
    // observed ones (managed by ExpressRouteCircuitConnection).
    drifted: (observed, body) => {
      const { sharedKey: _key, connections: _connections, ...desired } = body.properties;
      return subsetDiffers(desired, observed.properties);
    },
    writeOnlyChanged: (news, olds) =>
      secretChanged(news.sharedKey, olds?.sharedKey, olds !== undefined),
    toAttrs: (path, observed) => ({
      peeringName: path.name,
      peeringId: observed.id ?? "",
      circuit: path.circuit!,
      resourceGroup: path.resourceGroup,
      peeringType: observed.properties?.peeringType,
      state: observed.properties?.state,
      azureAsn: observed.properties?.azureASN,
      primaryAzurePort: observed.properties?.primaryAzurePort,
      secondaryAzurePort: observed.properties?.secondaryAzurePort,
    }),
    dependsOn: ["Azure.Network.ExpressRouteCircuit"],
  });
  return Provider.succeed(ExpressRouteCircuitPeering, {
    ...base,
    read: (args: Parameters<typeof base.read>[0]) =>
      base.read({ ...args, olds: args.olds && named(args.olds) }),
    reconcile: (args: Parameters<typeof base.reconcile>[0]) =>
      base.reconcile({ ...args, news: named(args.news) }),
  });
};
