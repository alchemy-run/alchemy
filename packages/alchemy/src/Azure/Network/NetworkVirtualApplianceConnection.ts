import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId, sameSet } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";
import {
  type HubRoutingConfiguration,
  routingConfigurationInput,
} from "./virtualHubShared.ts";

export interface NetworkVirtualApplianceConnectionProps {
  /** Resource group of the appliance. Changing it replaces the connection. */
  resourceGroup: string;
  /**
   * Name of the parent network virtual appliance. Changing it replaces the
   * connection.
   */
  networkVirtualAppliance: string;
  /**
   * Name of the connection. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /** BGP ASN of the appliance side. */
  asn?: number;
  /** Unique tunnel identifier of the connection. */
  tunnelIdentifier?: number;
  /** BGP peer addresses of the appliance instances. */
  bgpPeerAddresses?: string[];
  /**
   * Whether internet traffic from the connection is secured by the hub.
   * @default false
   */
  enableInternetSecurity?: boolean;
  /** Route table association and propagation of the connection. */
  routing?: HubRoutingConfiguration;
}

export interface NetworkVirtualApplianceConnection extends Resource<
  "Azure.Network.NetworkVirtualApplianceConnection",
  NetworkVirtualApplianceConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** Name of the parent appliance. */
    networkVirtualAppliance: string;
    /** Resource group of the appliance. */
    resourceGroup: string;
    /** BGP ASN of the appliance side. */
    asn: number | undefined;
    /** BGP peer addresses. */
    bgpPeerAddresses: string[];
    /** ARM ID of the associated hub route table. */
    associatedRouteTableId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A connection between a network virtual appliance and its Virtual WAN
 * hub router — the BGP session and route-table association/propagation of
 * an NVA deployed in the hub. Connections carry no tags: ownership follows
 * the parent appliance.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/about-nva-hub
 *
 * ### Connecting an NVA
 * **Example:** Propagate the NVA's routes to the default route table
 * ```typescript
 * yield* Azure.Network.NetworkVirtualApplianceConnection("bgp", {
 *   resourceGroup: group.resourceGroupName,
 *   networkVirtualAppliance: nva.networkVirtualApplianceName,
 *   asn: 64512,
 *   bgpPeerAddresses: ["10.100.0.70", "10.100.0.71"],
 *   routing: {
 *     associatedRouteTableId: `${hub.virtualHubId}/hubRouteTables/defaultRouteTable`,
 *     propagatedLabels: ["default"],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const NetworkVirtualApplianceConnection =
  Resource<NetworkVirtualApplianceConnection>(
    "Azure.Network.NetworkVirtualApplianceConnection",
  );

export const NetworkVirtualApplianceConnectionProvider = () =>
  Provider.succeed(
    NetworkVirtualApplianceConnection,
    networkProvider<NetworkVirtualApplianceConnection>()({
      label: "network virtual appliance connection",
      nameAttr: "connectionName",
      parents: ["networkVirtualAppliance"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkVirtualApplianceConnection({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkVirtualApplianceName: path.networkVirtualAppliance!,
            connectionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkVirtualApplianceConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkVirtualApplianceName: path.networkVirtualAppliance!,
          connectionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkVirtualApplianceConnection({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkVirtualApplianceName: path.networkVirtualAppliance!,
          connectionName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkVirtualAppliance({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkVirtualApplianceName: path.networkVirtualAppliance!,
          }),
        ).pipe(Effect.map((nva) => nva?.tags)),
      body: (news, { path }) => ({
        name: path.name,
        properties: {
          name: path.name,
          asn: news.asn,
          tunnelIdentifier: news.tunnelIdentifier,
          bgpPeerAddress: news.bgpPeerAddresses,
          enableInternetSecurity: news.enableInternetSecurity ?? false,
          routingConfiguration: routingConfigurationInput(news.routing),
        },
      }),
      drifted: (observed, _body, news) => {
        const p = observed.properties;
        const routing = p?.routingConfiguration;
        return (
          (news.asn !== undefined && p?.asn !== news.asn) ||
          (news.tunnelIdentifier !== undefined &&
            p?.tunnelIdentifier !== news.tunnelIdentifier) ||
          (news.bgpPeerAddresses !== undefined &&
            !sameSet(p?.bgpPeerAddress, news.bgpPeerAddresses)) ||
          (p?.enableInternetSecurity ?? false) !==
            (news.enableInternetSecurity ?? false) ||
          (news.routing?.associatedRouteTableId !== undefined &&
            !sameId(
              routing?.associatedRouteTable?.id,
              news.routing.associatedRouteTableId,
            )) ||
          (news.routing?.propagatedRouteTableIds !== undefined &&
            !sameSet(
              idsOf(routing?.propagatedRouteTables?.ids),
              news.routing.propagatedRouteTableIds,
            )) ||
          (news.routing?.propagatedLabels !== undefined &&
            !sameSet(
              routing?.propagatedRouteTables?.labels,
              news.routing.propagatedLabels,
            ))
        );
      },
      toAttrs: (path, observed) => ({
        connectionName: path.name,
        connectionId: observed.id ?? "",
        networkVirtualAppliance: path.networkVirtualAppliance!,
        resourceGroup: path.resourceGroup,
        asn: observed.properties?.asn,
        bgpPeerAddresses: [...(observed.properties?.bgpPeerAddress ?? [])],
        associatedRouteTableId:
          observed.properties?.routingConfiguration?.associatedRouteTable?.id,
      }),
      dependsOn: ["Azure.Network.NetworkVirtualAppliance"],
    }),
  );
