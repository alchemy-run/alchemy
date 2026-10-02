import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import { loadBalancerTags } from "./loadBalancerShared.ts";

export interface InboundNatRuleProps {
  /** Resource group of the load balancer. Changing it replaces the inbound NAT rule. */
  resourceGroup: string;
  /** Name of the parent load balancer. Changing it replaces the inbound NAT rule. */
  loadBalancer: string;
  /**
   * Name of the inbound NAT rule. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the inbound NAT rule.
   */
  name?: string;
  /** Name of the load balancer frontend IP configuration the rule listens on. */
  frontendIpConfiguration: string;
  /** Transport protocol. */
  protocol: "Tcp" | "Udp" | "All";
  /**
   * Frontend port (single-VM rule). Set this, or `frontendPortRangeStart`/
   * `frontendPortRangeEnd` with `backendAddressPool` (pool rule).
   */
  frontendPort?: number;
  /** First frontend port of a pool rule. */
  frontendPortRangeStart?: number;
  /** Last frontend port of a pool rule. */
  frontendPortRangeEnd?: number;
  /** Name of the backend pool (pool rule). */
  backendAddressPool?: string;
  /** Backend port. */
  backendPort: number;
  /**
   * TCP idle timeout in minutes (4-100).
   * @default 4
   */
  idleTimeoutInMinutes?: number;
  /** Enable floating IP (direct server return). @default false */
  enableFloatingIP?: boolean;
  /** Send TCP resets on idle timeout. @default false */
  enableTcpReset?: boolean;
}

export interface InboundNatRule extends Resource<
  "Azure.Network.InboundNatRule",
  InboundNatRuleProps,
  {
    /** Name of the inbound NAT rule. */
    inboundNatRuleName: string;
    /** ARM resource ID of the inbound NAT rule. */
    inboundNatRuleId: string;
    /** Name of the parent load balancer. */
    loadBalancer: string;
    /** Resource group of the load balancer. */
    resourceGroup: string;
    /** Transport protocol. */
    protocol: string | undefined;
    /** Frontend port. */
    frontendPort: number | undefined;
    /** Backend port. */
    backendPort: number | undefined;
    /** ID of the NIC IP configuration the rule forwards to. */
    backendIpConfigurationId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An inbound NAT rule on an Azure load balancer — forwards one frontend
 * port (or a port range across a backend pool) to a backend port, e.g.
 * SSH to individual VMs. Rules carry no tags: ownership follows the load
 * balancer. Attach a single-VM rule from the NIC's IP configuration.
 *
 * @see https://learn.microsoft.com/azure/load-balancer/inbound-nat-rules
 *
 * ### Creating a Rule
 * **Example:** SSH to a VM on port 50022
 * ```typescript
 * yield* Azure.Network.InboundNatRule("ssh", {
 *   resourceGroup: group.resourceGroupName,
 *   loadBalancer: lb.loadBalancerName,
 *   frontendIpConfiguration: "public",
 *   protocol: "Tcp",
 *   frontendPort: 50022,
 *   backendPort: 22,
 * });
 * ```
 *
 * @resource
 */
export const InboundNatRule = Resource<InboundNatRule>(
  "Azure.Network.InboundNatRule",
);

export const InboundNatRuleProvider = () =>
  Provider.succeed(
    InboundNatRule,
    networkProvider<InboundNatRule>()({
      label: "inbound NAT rule",
      nameAttr: "inboundNatRuleName",
      parents: ["loadBalancer"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetInboundNatRule({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            loadBalancerName: path.loadBalancer!,
            inboundNatRuleName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.InboundNatRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          loadBalancerName: path.loadBalancer!,
          inboundNatRuleName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteInboundNatRule({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          loadBalancerName: path.loadBalancer!,
          inboundNatRuleName: path.name,
        }),
      ownerTags: loadBalancerTags,
      body: (news, { subscriptionId, path }) => {
        const lbId = `/subscriptions/${subscriptionId}/resourceGroups/${path.resourceGroup}/providers/Microsoft.Network/loadBalancers/${path.loadBalancer}`;
        return {
          properties: {
            frontendIPConfiguration: {
              id: `${lbId}/frontendIPConfigurations/${news.frontendIpConfiguration}`,
            },
            protocol: news.protocol,
            frontendPort: news.frontendPort,
            frontendPortRangeStart: news.frontendPortRangeStart,
            frontendPortRangeEnd: news.frontendPortRangeEnd,
            backendAddressPool:
              news.backendAddressPool === undefined
                ? undefined
                : {
                    id: `${lbId}/backendAddressPools/${news.backendAddressPool}`,
                  },
            backendPort: news.backendPort,
            idleTimeoutInMinutes: news.idleTimeoutInMinutes ?? 4,
            enableFloatingIP: news.enableFloatingIP ?? false,
            enableTcpReset: news.enableTcpReset ?? false,
          },
        };
      },
      toAttrs: (path, observed) => ({
        inboundNatRuleName: path.name,
        inboundNatRuleId: observed.id ?? "",
        loadBalancer: path.loadBalancer!,
        resourceGroup: path.resourceGroup,
        protocol: observed.properties?.protocol,
        frontendPort: observed.properties?.frontendPort,
        backendPort: observed.properties?.backendPort,
        backendIpConfigurationId:
          observed.properties?.backendIPConfiguration?.id,
      }),
      dependsOn: ["Azure.Network.LoadBalancer"],
    }),
  );
