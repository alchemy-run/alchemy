import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import type { NatRuleMapping } from "./VpnGatewayNatRule.ts";

export interface VirtualNetworkGatewayNatRuleProps {
  /** Resource group of the gateway. Changing it replaces the rule. */
  resourceGroup: string;
  /**
   * Name of the parent virtual network gateway (route-based VpnGw2 or
   * higher). Changing it replaces the rule.
   */
  virtualNetworkGateway: string;
  /**
   * Name of the NAT rule. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /**
   * NAT type: `Static` (1:1 prefix mapping) or `Dynamic`.
   * @default "Static"
   */
  type?: "Static" | "Dynamic";
  /**
   * Direction: `EgressSnat` translates hub-side addresses, `IngressSnat`
   * translates branch-side addresses.
   * @default "EgressSnat"
   */
  mode?: "EgressSnat" | "IngressSnat";
  /** Pre-translation address spaces. */
  internalMappings: NatRuleMapping[];
  /** Post-translation address spaces. */
  externalMappings: NatRuleMapping[];
  /**
   * Gateway instance the rule applies to (`"Instance0"` or `"Instance1"`);
   * both when omitted.
   */
  ipConfigurationId?: string;
}

export interface VirtualNetworkGatewayNatRule extends Resource<
  "Azure.Network.VirtualNetworkGatewayNatRule",
  VirtualNetworkGatewayNatRuleProps,
  {
    /** Name of the NAT rule. */
    natRuleName: string;
    /** ARM resource ID of the NAT rule. */
    natRuleId: string;
    /** Name of the parent virtual network gateway. */
    virtualNetworkGateway: string;
    /** Resource group of the gateway. */
    resourceGroup: string;
    /** NAT type. */
    type: string | undefined;
    /** NAT mode. */
    mode: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A NAT rule on an Azure {@link VirtualNetworkGateway} (VPN) — translates
 * overlapping on-premises or VNet address spaces. Reference it from a
 * {@link VirtualNetworkGatewayConnection}'s `ingressNatRuleIds` /
 * `egressNatRuleIds`. NAT rules carry no tags: ownership follows the
 * parent gateway.
 *
 * @see https://learn.microsoft.com/azure/vpn-gateway/nat-howto
 *
 * ### Creating a NAT Rule
 * **Example:** Static egress SNAT
 * ```typescript
 * yield* Azure.Network.VirtualNetworkGatewayNatRule("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetworkGateway: gateway.virtualNetworkGatewayName,
 *   mode: "EgressSnat",
 *   internalMappings: [{ addressSpace: "10.4.0.0/24" }],
 *   externalMappings: [{ addressSpace: "192.168.21.0/24" }],
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkGatewayNatRule = Resource<VirtualNetworkGatewayNatRule>(
  "Azure.Network.VirtualNetworkGatewayNatRule",
);

export const VirtualNetworkGatewayNatRuleProvider = () =>
  Provider.succeed(
    VirtualNetworkGatewayNatRule,
    networkProvider<VirtualNetworkGatewayNatRule>()({
      label: "virtual network gateway NAT rule",
      nameAttr: "natRuleName",
      parents: ["virtualNetworkGateway"],
      tracked: false,
      slow: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualNetworkGatewayNatRule({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualNetworkGatewayName: path.virtualNetworkGateway!,
            natRuleName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualNetworkGatewayNatRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkGatewayName: path.virtualNetworkGateway!,
          natRuleName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualNetworkGatewayNatRule({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualNetworkGatewayName: path.virtualNetworkGateway!,
          natRuleName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualNetworkGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualNetworkGatewayName: path.virtualNetworkGateway!,
          }),
        ).pipe(Effect.map((gateway) => gateway?.tags)),
      body: (news) => ({
        properties: {
          type: news.type ?? "Static",
          mode: news.mode ?? "EgressSnat",
          internalMappings: news.internalMappings,
          externalMappings: news.externalMappings,
          ipConfigurationId: news.ipConfigurationId,
        },
      }),
      toAttrs: (path, observed) => ({
        natRuleName: path.name,
        natRuleId: observed.id ?? "",
        virtualNetworkGateway: path.virtualNetworkGateway!,
        resourceGroup: path.resourceGroup,
        type: observed.properties?.type,
        mode: observed.properties?.mode,
      }),
      dependsOn: ["Azure.Network.VirtualNetworkGateway"],
    }),
  );
