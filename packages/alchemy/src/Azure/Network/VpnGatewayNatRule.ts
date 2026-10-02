import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";

/** One side of a NAT mapping. */
export interface NatRuleMapping {
  /** Address space (CIDR), e.g. `"10.4.0.0/24"`. */
  addressSpace: string;
  /** Port range, e.g. `"1000-2000"` (port-based NAT). */
  portRange?: string;
}

export interface VpnGatewayNatRuleProps {
  /** Resource group of the VPN gateway. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the parent VPN gateway. Changing it replaces the rule. */
  vpnGateway: string;
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

export interface VpnGatewayNatRule extends Resource<
  "Azure.Network.VpnGatewayNatRule",
  VpnGatewayNatRuleProps,
  {
    /** Name of the NAT rule. */
    natRuleName: string;
    /** ARM resource ID of the NAT rule. */
    natRuleId: string;
    /** Name of the parent VPN gateway. */
    vpnGateway: string;
    /** Resource group of the VPN gateway. */
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
 * A NAT rule on an Azure Virtual WAN {@link VpnGateway} — translates
 * overlapping branch or hub address spaces. Reference it from a
 * {@link VpnConnection} link's `ingressNatRuleIds` / `egressNatRuleIds`.
 * NAT rules carry no tags: ownership follows the parent gateway.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/nat-rules-vpn-gateway
 *
 * ### Creating a NAT Rule
 * **Example:** Static egress SNAT
 * ```typescript
 * yield* Azure.Network.VpnGatewayNatRule("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   vpnGateway: gateway.vpnGatewayName,
 *   mode: "EgressSnat",
 *   internalMappings: [{ addressSpace: "10.4.0.0/24" }],
 *   externalMappings: [{ addressSpace: "192.168.21.0/24" }],
 * });
 * ```
 *
 * @resource
 */
export const VpnGatewayNatRule = Resource<VpnGatewayNatRule>(
  "Azure.Network.VpnGatewayNatRule",
);

export const VpnGatewayNatRuleProvider = () =>
  Provider.succeed(
    VpnGatewayNatRule,
    networkProvider<VpnGatewayNatRule>()({
      label: "VPN gateway NAT rule",
      nameAttr: "natRuleName",
      parents: ["vpnGateway"],
      tracked: false,
      slow: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNatRule({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            gatewayName: path.vpnGateway!,
            natRuleName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NatRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.vpnGateway!,
          natRuleName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNatRule({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          gatewayName: path.vpnGateway!,
          natRuleName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVpnGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            gatewayName: path.vpnGateway!,
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
        vpnGateway: path.vpnGateway!,
        resourceGroup: path.resourceGroup,
        type: observed.properties?.type,
        mode: observed.properties?.mode,
      }),
      dependsOn: ["Azure.Network.VpnGateway"],
    }),
  );
