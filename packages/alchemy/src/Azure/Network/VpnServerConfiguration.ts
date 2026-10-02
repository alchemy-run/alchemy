import * as network from "@distilled.cloud/azure/network";
import type * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { reveal, secretChanged } from "./common.ts";
import { idsOf, networkProvider, subsetDiffers } from "./generic.ts";

/** A certificate trusted (or revoked) for point-to-site clients. */
export interface VpnServerCertificate {
  /** Name of the certificate entry. */
  name: string;
  /** Base64 public certificate data (root certificates). */
  publicCertData?: string;
  /** Certificate thumbprint (revoked certificates). */
  thumbprint?: string;
}

export interface VpnServerConfigurationProps {
  /**
   * Resource group of the configuration. Changing it replaces the
   * configuration.
   */
  resourceGroup: string;
  /**
   * Name of the configuration: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the configuration.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the configuration.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * VPN tunnel protocols offered to clients.
   * @default ["OpenVPN"]
   */
  vpnProtocols?: ("IkeV2" | "OpenVPN")[];
  /**
   * Client authentication types.
   * @default ["Certificate"]
   */
  vpnAuthenticationTypes?: ("Certificate" | "Radius" | "AAD")[];
  /** Root certificates trusted for certificate authentication. */
  vpnClientRootCertificates?: { name: string; publicCertData: string }[];
  /** Client certificates revoked for certificate authentication. */
  vpnClientRevokedCertificates?: { name: string; thumbprint: string }[];
  /** RADIUS server address (RADIUS authentication). */
  radiusServerAddress?: string;
  /**
   * RADIUS shared secret. Azure never returns it, so a change is detected
   * against the previous deploy's value.
   */
  radiusServerSecret?: string | Redacted.Redacted<string>;
  /** Microsoft Entra ID settings (AAD authentication). */
  aad?: {
    /** Tenant URL, e.g. `https://login.microsoftonline.com/<tenant-id>`. */
    tenant: string;
    /** Audience (application ID of the Azure VPN client). */
    audience: string;
    /** Issuer URL, e.g. `https://sts.windows.net/<tenant-id>/`. */
    issuer: string;
  };
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VpnServerConfiguration extends Resource<
  "Azure.Network.VpnServerConfiguration",
  VpnServerConfigurationProps,
  {
    /** Name of the configuration. */
    vpnServerConfigurationName: string;
    /** ARM resource ID of the configuration. */
    vpnServerConfigurationId: string;
    /** Resource group of the configuration. */
    resourceGroup: string;
    /** Location of the configuration. */
    location: string;
    /** VPN tunnel protocols. */
    vpnProtocols: string[];
    /** Client authentication types. */
    vpnAuthenticationTypes: string[];
    /** Names of the configuration's policy groups. */
    policyGroupNames: string[];
    /** IDs of the point-to-site gateways using the configuration. */
    p2sVpnGatewayIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual WAN VPN server configuration — the point-to-site
 * settings (protocols, certificate / RADIUS / Entra ID authentication) a
 * hub {@link P2sVpnGateway} offers to clients. Configurations are free.
 * Add policy groups with {@link VpnServerConfigurationPolicyGroup}.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-point-to-site-portal
 *
 * ### Creating a VPN Server Configuration
 * **Example:** Certificate authentication over OpenVPN
 * ```typescript
 * const config = yield* Azure.Network.VpnServerConfiguration("p2s", {
 *   resourceGroup: group.resourceGroupName,
 *   vpnProtocols: ["OpenVPN"],
 *   vpnAuthenticationTypes: ["Certificate"],
 *   vpnClientRootCertificates: [{ name: "root", publicCertData: rootCertBase64 }],
 * });
 * ```
 *
 * **Example:** Entra ID authentication
 * ```typescript
 * const config = yield* Azure.Network.VpnServerConfiguration("p2s-aad", {
 *   resourceGroup: group.resourceGroupName,
 *   vpnAuthenticationTypes: ["AAD"],
 *   aad: {
 *     tenant: `https://login.microsoftonline.com/${tenantId}`,
 *     audience: "c632b3df-fb67-4d84-bdcf-b95ad541b5c8",
 *     issuer: `https://sts.windows.net/${tenantId}/`,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const VpnServerConfiguration = Resource<VpnServerConfiguration>(
  "Azure.Network.VpnServerConfiguration",
);

export const VpnServerConfigurationProvider = () =>
  Provider.succeed(
    VpnServerConfiguration,
    networkProvider<VpnServerConfiguration>()({
      label: "VPN server configuration",
      nameAttr: "vpnServerConfigurationName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVpnServerConfiguration({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            vpnServerConfigurationName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VpnServerConfigurationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          vpnServerConfigurationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVpnServerConfiguration({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          vpnServerConfigurationName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVpnServerConfigurationTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          vpnServerConfigurationName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListVpnServerConfigurations({ subscriptionId }),
      // The PUT replaces the policy-group collection: carry the observed
      // groups (managed by VpnServerConfigurationPolicyGroup).
      body: (news, { location, tags, observed }) => ({
        location,
        tags,
        properties: {
          vpnProtocols: news.vpnProtocols ?? ["OpenVPN"],
          vpnAuthenticationTypes: news.vpnAuthenticationTypes ?? [
            "Certificate",
          ],
          vpnClientRootCertificates: news.vpnClientRootCertificates ?? [],
          vpnClientRevokedCertificates: news.vpnClientRevokedCertificates ?? [],
          radiusServerAddress: news.radiusServerAddress,
          radiusServerSecret: reveal(news.radiusServerSecret),
          aadAuthenticationParameters: news.aad && {
            aadTenant: news.aad.tenant,
            aadAudience: news.aad.audience,
            aadIssuer: news.aad.issuer,
          },
          configurationPolicyGroups: (
            observed?.properties?.configurationPolicyGroups ?? []
          ).map((group) => ({
            id: group.id,
            name: group.name,
            properties: group.properties && {
              isDefault: group.properties.isDefault,
              priority: group.properties.priority,
              policyMembers: group.properties.policyMembers,
            },
          })),
        },
      }),
      drifted: (observed, body) => {
        const {
          radiusServerSecret: _secret,
          configurationPolicyGroups: _groups,
          ...desired
        } = body.properties;
        return subsetDiffers(desired, observed.properties);
      },
      writeOnlyChanged: (news, olds) =>
        secretChanged(
          news.radiusServerSecret,
          olds?.radiusServerSecret,
          olds !== undefined,
        ),
      toAttrs: (path, observed) => ({
        vpnServerConfigurationName: path.name,
        vpnServerConfigurationId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        vpnProtocols: [...(observed.properties?.vpnProtocols ?? [])],
        vpnAuthenticationTypes: [
          ...(observed.properties?.vpnAuthenticationTypes ?? []),
        ],
        policyGroupNames: (
          observed.properties?.configurationPolicyGroups ?? []
        ).flatMap((group) => (group.name === undefined ? [] : [group.name])),
        p2sVpnGatewayIds: idsOf(observed.properties?.p2SVpnGateways),
        tags: userTags(observed.tags),
      }),
    }),
  );
