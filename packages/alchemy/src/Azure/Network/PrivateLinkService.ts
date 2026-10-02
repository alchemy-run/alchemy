import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId, sameSet } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface PrivateLinkServiceIpConfiguration {
  /** Name of the NAT IP configuration. */
  name: string;
  /** ARM ID of the subnet the NAT IP comes from (`privateLinkServiceNetworkPolicies: "Disabled"`). */
  subnetId: string;
  /** Static private IP. @default dynamic */
  privateIpAddress?: string;
  /** Whether this is the primary NAT IP. Exactly one must be primary. */
  primary?: boolean;
}

export interface PrivateLinkServiceProps {
  /** Resource group of the service. Changing it replaces the service. */
  resourceGroup: string;
  /**
   * Name of the private link service: 1-80 letters, digits, `_`, `.`,
   * and `-`. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the service.
   */
  name?: string;
  /**
   * Azure location (must match the load balancer). Changing it replaces
   * the service.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM IDs of the internal Standard load balancer frontend IP
   * configurations the service exposes.
   */
  loadBalancerFrontendIpConfigurationIds: string[];
  /** NAT IP configurations (source IPs consumers' traffic arrives from). */
  ipConfigurations: PrivateLinkServiceIpConfiguration[];
  /** Subscriptions allowed to find the service by alias. @default none (approval-only by alias) */
  visibilitySubscriptions?: string[];
  /** Subscriptions whose private endpoints are approved automatically. */
  autoApprovalSubscriptions?: string[];
  /** FQDNs that resolve to the service. */
  fqdns?: string[];
  /** Pass the consumer's connection info via TCP proxy protocol v2. @default false */
  enableProxyProtocol?: boolean;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface PrivateLinkService extends Resource<
  "Azure.Network.PrivateLinkService",
  PrivateLinkServiceProps,
  {
    /** Name of the service. */
    privateLinkServiceName: string;
    /** ARM resource ID of the service (target of private endpoints). */
    privateLinkServiceId: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Location of the service. */
    location: string;
    /** Globally unique alias consumers can connect to. */
    alias: string | undefined;
    /** IDs of the service's network interfaces. */
    networkInterfaceIds: string[];
    /** IDs of the connected private endpoint connections. */
    privateEndpointConnectionIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Private Link service — exposes an internal Standard load
 * balancer to private endpoints in other virtual networks, subscriptions,
 * or tenants. Approve pending connections with
 * {@link PrivateLinkServiceConnectionApproval}. Bills ~$0.01/hour per
 * connected endpoint plus data.
 *
 * @see https://learn.microsoft.com/azure/private-link/private-link-service-overview
 *
 * ### Creating a Service
 * **Example:** Expose an internal load balancer
 * ```typescript
 * const service = yield* Azure.Network.PrivateLinkService("api", {
 *   resourceGroup: group.resourceGroupName,
 *   loadBalancerFrontendIpConfigurationIds: [
 *     Output.interpolate`${lb.loadBalancerId}/frontendIPConfigurations/internal`,
 *   ],
 *   ipConfigurations: [{ name: "nat", subnetId: natSubnet.subnetId, primary: true }],
 *   visibilitySubscriptions: [partnerSubscriptionId],
 * });
 * ```
 *
 * @resource
 */
export const PrivateLinkService = Resource<PrivateLinkService>(
  "Azure.Network.PrivateLinkService",
);

export const PrivateLinkServiceProvider = () =>
  Provider.succeed(
    PrivateLinkService,
    networkProvider<PrivateLinkService>()({
      label: "private link service",
      nameAttr: "privateLinkServiceName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetPrivateLinkService({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            serviceName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.PrivateLinkServicesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeletePrivateLinkService({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceName: path.name,
        }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          loadBalancerFrontendIpConfigurations:
            news.loadBalancerFrontendIpConfigurationIds.map((id) => ({ id })),
          ipConfigurations: news.ipConfigurations.map((ip, i) => ({
            name: ip.name,
            properties: {
              subnet: { id: ip.subnetId },
              privateIPAddress: ip.privateIpAddress,
              privateIPAllocationMethod:
                ip.privateIpAddress === undefined ? "Dynamic" : "Static",
              primary: ip.primary ?? i === 0,
              privateIPAddressVersion: "IPv4",
            },
          })),
          visibility: { subscriptions: news.visibilitySubscriptions ?? [] },
          autoApproval: { subscriptions: news.autoApprovalSubscriptions ?? [] },
          fqdns: news.fqdns ?? [],
          enableProxyProtocol: news.enableProxyProtocol ?? false,
        },
      }),
      drifted: (observed, _body, news) => {
        const p = observed.properties;
        const observedIps = (p?.ipConfigurations ?? []).map((ip) => ({
          name: ip.name?.toLowerCase(),
          subnet: ip.properties?.subnet?.id?.toLowerCase(),
        }));
        return (
          !sameSet(
            idsOf(p?.loadBalancerFrontendIpConfigurations),
            news.loadBalancerFrontendIpConfigurationIds,
          ) ||
          observedIps.length !== news.ipConfigurations.length ||
          news.ipConfigurations.some(
            (ip) =>
              !observedIps.some(
                (o) => sameId(o.name, ip.name) && sameId(o.subnet, ip.subnetId),
              ),
          ) ||
          !sameSet(
            p?.visibility?.subscriptions,
            news.visibilitySubscriptions,
          ) ||
          !sameSet(
            p?.autoApproval?.subscriptions,
            news.autoApprovalSubscriptions,
          ) ||
          !sameSet(p?.fqdns, news.fqdns) ||
          (p?.enableProxyProtocol ?? false) !==
            (news.enableProxyProtocol ?? false)
        );
      },
      toAttrs: (path, observed) => ({
        privateLinkServiceName: path.name,
        privateLinkServiceId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        alias: observed.properties?.alias,
        networkInterfaceIds: idsOf(observed.properties?.networkInterfaces),
        privateEndpointConnectionIds: idsOf(
          observed.properties?.privateEndpointConnections,
        ),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.LoadBalancer"],
    }),
  );
