import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";

/** A member of a policy group: one client attribute value it matches. */
export interface VpnPolicyGroupMember {
  /** Name of the member. */
  name: string;
  /** Client attribute the member matches. */
  attributeType: "CertificateGroupId" | "AADGroupId" | "RadiusAzureGroupId";
  /** Attribute value, e.g. a certificate group ID or an Entra group ID. */
  attributeValue: string;
}

export interface VpnServerConfigurationPolicyGroupProps {
  /**
   * Resource group of the VPN server configuration. Changing it replaces
   * the group.
   */
  resourceGroup: string;
  /**
   * Name of the parent VPN server configuration. Changing it replaces the
   * group.
   */
  vpnServerConfiguration: string;
  /**
   * Name of the policy group. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * Whether this is the configuration's default policy group.
   * @default false
   */
  isDefault?: boolean;
  /**
   * Priority of the group (lower is evaluated first).
   * @default 0
   */
  priority?: number;
  /** Client attribute values that select this group. */
  policyMembers: VpnPolicyGroupMember[];
}

export interface VpnServerConfigurationPolicyGroup extends Resource<
  "Azure.Network.VpnServerConfigurationPolicyGroup",
  VpnServerConfigurationPolicyGroupProps,
  {
    /** Name of the policy group. */
    policyGroupName: string;
    /** ARM resource ID of the policy group. */
    policyGroupId: string;
    /** Name of the parent VPN server configuration. */
    vpnServerConfiguration: string;
    /** Resource group of the configuration. */
    resourceGroup: string;
    /** Whether this is the default group. */
    isDefault: boolean | undefined;
    /** Priority of the group. */
    priority: number | undefined;
    /** IDs of the P2S connection configurations using the group. */
    p2sConnectionConfigurationIds: string[];
  },
  never,
  Providers
> {}

/**
 * A policy group of an Azure Virtual WAN VPN server configuration — maps
 * point-to-site users (by certificate group, Entra group, or RADIUS
 * attribute) to a P2S connection configuration with its own address pool.
 * Policy groups carry no tags: ownership follows the parent configuration.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/user-groups-about
 *
 * ### Creating a Policy Group
 * **Example:** Default group for an engineering certificate group
 * ```typescript
 * yield* Azure.Network.VpnServerConfigurationPolicyGroup("engineering", {
 *   resourceGroup: group.resourceGroupName,
 *   vpnServerConfiguration: config.vpnServerConfigurationName,
 *   isDefault: true,
 *   priority: 0,
 *   policyMembers: [
 *     { name: "eng", attributeType: "CertificateGroupId", attributeValue: "eng.contoso.com" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const VpnServerConfigurationPolicyGroup =
  Resource<VpnServerConfigurationPolicyGroup>(
    "Azure.Network.VpnServerConfigurationPolicyGroup",
  );

export const VpnServerConfigurationPolicyGroupProvider = () =>
  Provider.succeed(
    VpnServerConfigurationPolicyGroup,
    networkProvider<VpnServerConfigurationPolicyGroup>()({
      label: "VPN server configuration policy group",
      nameAttr: "policyGroupName",
      parents: ["vpnServerConfiguration"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetConfigurationPolicyGroup({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            vpnServerConfigurationName: path.vpnServerConfiguration!,
            configurationPolicyGroupName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ConfigurationPolicyGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          vpnServerConfigurationName: path.vpnServerConfiguration!,
          configurationPolicyGroupName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteConfigurationPolicyGroup({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          vpnServerConfigurationName: path.vpnServerConfiguration!,
          configurationPolicyGroupName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVpnServerConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            vpnServerConfigurationName: path.vpnServerConfiguration!,
          }),
        ).pipe(Effect.map((config) => config?.tags)),
      body: (news) => ({
        properties: {
          isDefault: news.isDefault ?? false,
          priority: news.priority ?? 0,
          policyMembers: news.policyMembers,
        },
      }),
      toAttrs: (path, observed) => ({
        policyGroupName: path.name,
        policyGroupId: observed.id ?? "",
        vpnServerConfiguration: path.vpnServerConfiguration!,
        resourceGroup: path.resourceGroup,
        isDefault: observed.properties?.isDefault,
        priority: observed.properties?.priority,
        p2sConnectionConfigurationIds: (
          observed.properties?.p2SConnectionConfigurations ?? []
        ).flatMap((c) => (c.id === undefined ? [] : [c.id])),
      }),
      dependsOn: ["Azure.Network.VpnServerConfiguration"],
    }),
  );
