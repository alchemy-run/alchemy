import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";
import {
  routingConfigurationInput,
  type HubRoutingConfiguration,
} from "./virtualHubShared.ts";

/** A point-to-site connection configuration (client address pool). */
export interface P2sConnectionConfigurationSpec {
  /** Name of the configuration. */
  name: string;
  /** Client address pool prefixes, e.g. `["172.16.0.0/24"]`. */
  addressPrefixes: string[];
  /**
   * Route clients' internet traffic through the hub's secured edge.
   * @default false
   */
  enableInternetSecurity?: boolean;
  /** Route-table association and propagation. */
  routing?: HubRoutingConfiguration;
  /**
   * ARM IDs of the VPN server configuration policy groups mapped to this
   * pool (user-group-based pools).
   */
  policyGroupIds?: string[];
}

export interface P2sVpnGatewayProps {
  /** Resource group of the gateway. Changing it replaces the gateway. */
  resourceGroup: string;
  /**
   * Name of the gateway: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the gateway.
   */
  name?: string;
  /**
   * Azure location (must match the hub's). Changing it replaces the
   * gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** ARM ID of the virtual hub. Changing it replaces the gateway. */
  virtualHubId: string;
  /** ARM ID of the VPN server configuration (authentication settings). */
  vpnServerConfigurationId: string;
  /** Client connection configurations (one address pool each). */
  connectionConfigurations: P2sConnectionConfigurationSpec[];
  /**
   * Scale units (1 unit = 500 Mbps / 500 connections).
   * @default 1
   */
  scaleUnit?: number;
  /** Custom DNS servers pushed to clients. */
  customDnsServers?: string[];
  /**
   * Use internet routing for the gateway's public IPs. Only honoured when
   * the gateway is created.
   * @default false
   */
  isRoutingPreferenceInternet?: boolean;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface P2sVpnGateway extends Resource<
  "Azure.Network.P2sVpnGateway",
  P2sVpnGatewayProps,
  {
    /** Name of the gateway. */
    p2sVpnGatewayName: string;
    /** ARM resource ID of the gateway. */
    p2sVpnGatewayId: string;
    /** Resource group of the gateway. */
    resourceGroup: string;
    /** Location of the gateway. */
    location: string;
    /** ARM ID of the virtual hub. */
    virtualHubId: string | undefined;
    /** ARM ID of the VPN server configuration. */
    vpnServerConfigurationId: string | undefined;
    /** Scale units. */
    scaleUnit: number | undefined;
    /** ARM IDs of the connection configurations. */
    connectionConfigurationIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual WAN point-to-site (user) VPN gateway in a virtual hub.
 * Authentication comes from a {@link VpnServerConfiguration}. Billed per
 * scale unit (about $0.36/hour for 1 unit) plus per connection, and takes
 * 30+ minutes to provision.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-point-to-site-portal
 *
 * ### Creating a User VPN Gateway
 * **Example:** One address pool
 * ```typescript
 * const gateway = yield* Azure.Network.P2sVpnGateway("users", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHubId: hub.virtualHubId,
 *   vpnServerConfigurationId: config.vpnServerConfigurationId,
 *   connectionConfigurations: [
 *     { name: "default", addressPrefixes: ["172.16.0.0/24"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const P2sVpnGateway = Resource<P2sVpnGateway>(
  "Azure.Network.P2sVpnGateway",
);

export const P2sVpnGatewayProvider = () =>
  Provider.succeed(
    P2sVpnGateway,
    networkProvider<P2sVpnGateway>()({
      label: "point-to-site VPN gateway",
      nameAttr: "p2sVpnGatewayName",
      tracked: true,
      slow: true,
      immutable: (news, output) =>
        output.virtualHubId !== undefined &&
        !sameId(news.virtualHubId, output.virtualHubId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetP2sVpnGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            gatewayName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.P2sVpnGatewaysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteP2sVpnGateway({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateP2sVpnGatewayTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListP2sVpnGateways({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          virtualHub: { id: news.virtualHubId },
          vpnServerConfiguration: { id: news.vpnServerConfigurationId },
          vpnGatewayScaleUnit: news.scaleUnit ?? 1,
          customDnsServers: news.customDnsServers,
          isRoutingPreferenceInternet: news.isRoutingPreferenceInternet,
          p2SConnectionConfigurations: news.connectionConfigurations.map(
            (config) => ({
              name: config.name,
              properties: {
                vpnClientAddressPool: { addressPrefixes: config.addressPrefixes },
                enableInternetSecurity: config.enableInternetSecurity ?? false,
                routingConfiguration: routingConfigurationInput(config.routing),
                configurationPolicyGroupAssociations: config.policyGroupIds?.map(
                  (id) => ({ id }),
                ),
              },
            }),
          ),
        },
      }),
      toAttrs: (path, observed) => ({
        p2sVpnGatewayName: path.name,
        p2sVpnGatewayId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        virtualHubId: observed.properties?.virtualHub?.id,
        vpnServerConfigurationId: observed.properties?.vpnServerConfiguration?.id,
        scaleUnit: observed.properties?.vpnGatewayScaleUnit,
        connectionConfigurationIds: (
          observed.properties?.p2SConnectionConfigurations ?? []
        ).flatMap((c) => (c.id === undefined ? [] : [c.id])),
        tags: userTags(observed.tags),
      }),
      dependsOn: [
        "Azure.Network.VirtualHub",
        "Azure.Network.VpnServerConfiguration",
      ],
    }),
  );
