import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { canonical, ref } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";
import { loadBalancerTags } from "./loadBalancerShared.ts";

export interface LoadBalancerBackendAddressPoolProps {
  /** Resource group of the load balancer. Changing it replaces the backend address pool. */
  resourceGroup: string;
  /** Name of the parent load balancer. Changing it replaces the backend address pool. */
  loadBalancer: string;
  /**
   * Name of the backend address pool. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the backend address pool.
   */
  name?: string;
  /**
   * ARM ID of the virtual network of IP-based members. Required with
   * `addresses`.
   */
  virtualNetworkId?: string;
  /** IP-based members (NIC-based members join from the NIC side). */
  addresses?: {
    /** Name of the member. */
    name: string;
    /** Private IP of the member. */
    ipAddress: string;
  }[];
  /** Seconds to drain connections when a member is removed. */
  drainPeriodInSeconds?: number;
}

export interface LoadBalancerBackendAddressPool extends Resource<
  "Azure.Network.LoadBalancerBackendAddressPool",
  LoadBalancerBackendAddressPoolProps,
  {
    /** Name of the backend address pool. */
    backendAddressPoolName: string;
    /** ARM resource ID of the backend address pool. */
    backendAddressPoolId: string;
    /** Name of the parent load balancer. */
    loadBalancer: string;
    /** Resource group of the load balancer. */
    resourceGroup: string;
    /** IP-based members. */
    addresses: { name: string; ipAddress: string }[];
    /** IDs of the NIC IP configurations in the pool. */
    backendIpConfigurationIds: string[];
    /** IDs of the load-balancing rules using the pool. */
    loadBalancingRuleIds: string[];
  },
  never,
  Providers
> {}

/**
 * A backend address pool on an Azure load balancer, managed separately
 * from the load balancer (so other stacks or resources can add pools).
 * Members join by IP address (`addresses`) or from a network interface's
 * IP configuration. Pools carry no tags: ownership follows the load
 * balancer. Pools declared inline on the {@link LoadBalancer} and pools
 * managed here can coexist.
 *
 * @see https://learn.microsoft.com/azure/load-balancer/backend-pool-management
 *
 * ### Creating a Pool
 * **Example:** IP-based backend pool
 * ```typescript
 * yield* Azure.Network.LoadBalancerBackendAddressPool("web", {
 *   resourceGroup: group.resourceGroupName,
 *   loadBalancer: lb.loadBalancerName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 *   addresses: [{ name: "web1", ipAddress: "10.0.1.4" }],
 * });
 * ```
 *
 * @resource
 */
export const LoadBalancerBackendAddressPool =
  Resource<LoadBalancerBackendAddressPool>(
    "Azure.Network.LoadBalancerBackendAddressPool",
  );

export const LoadBalancerBackendAddressPoolProvider = () =>
  Provider.succeed(
    LoadBalancerBackendAddressPool,
    networkProvider<LoadBalancerBackendAddressPool>()({
      label: "backend address pool",
      nameAttr: "backendAddressPoolName",
      parents: ["loadBalancer"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetLoadBalancerBackendAddressPool({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            loadBalancerName: path.loadBalancer!,
            backendAddressPoolName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.LoadBalancerBackendAddressPoolsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          loadBalancerName: path.loadBalancer!,
          backendAddressPoolName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteLoadBalancerBackendAddressPool({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          loadBalancerName: path.loadBalancer!,
          backendAddressPoolName: path.name,
        }),
      ownerTags: loadBalancerTags,
      body: (news) => ({
        properties: {
          virtualNetwork: ref(news.virtualNetworkId),
          drainPeriodInSeconds: news.drainPeriodInSeconds,
          loadBalancerBackendAddresses: (news.addresses ?? []).map((a) => ({
            name: a.name,
            properties: { ipAddress: a.ipAddress },
          })),
        },
      }),
      drifted: (observed, _body, news) => {
        const p = observed.properties;
        const observedAddresses = (p?.loadBalancerBackendAddresses ?? [])
          .filter((a) => a.properties?.ipAddress !== undefined)
          .map((a) => `${a.name}=${a.properties?.ipAddress}`)
          .sort();
        const desiredAddresses = (news.addresses ?? [])
          .map((a) => `${a.name}=${a.ipAddress}`)
          .sort();
        return (
          canonical(observedAddresses) !== canonical(desiredAddresses) ||
          (news.drainPeriodInSeconds !== undefined &&
            p?.drainPeriodInSeconds !== news.drainPeriodInSeconds)
        );
      },
      toAttrs: (path, observed) => ({
        backendAddressPoolName: path.name,
        backendAddressPoolId: observed.id ?? "",
        loadBalancer: path.loadBalancer!,
        resourceGroup: path.resourceGroup,
        addresses: (
          observed.properties?.loadBalancerBackendAddresses ?? []
        ).flatMap((a) =>
          a.name !== undefined && a.properties?.ipAddress !== undefined
            ? [{ name: a.name, ipAddress: a.properties.ipAddress }]
            : [],
        ),
        backendIpConfigurationIds: idsOf(
          observed.properties?.backendIPConfigurations,
        ),
        loadBalancingRuleIds: idsOf(observed.properties?.loadBalancingRules),
      }),
      dependsOn: ["Azure.Network.LoadBalancer"],
    }),
  );
