import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";

/** BGP settings of a VPN site or site link. */
export interface VpnSiteBgp {
  /** BGP autonomous system number of the on-premises device. */
  asn: number;
  /** BGP peer IP address of the on-premises device. */
  bgpPeeringAddress: string;
}

/** One physical link of a VPN site. */
export interface VpnSiteLinkSpec {
  /** Name of the link, unique within the site. */
  name: string;
  /** Public IP address of the on-premises VPN device on this link. */
  ipAddress?: string;
  /** FQDN of the on-premises VPN device (instead of `ipAddress`). */
  fqdn?: string;
  /** Name of the link's ISP, e.g. `"Contoso ISP"`. */
  providerName?: string;
  /** Link speed in Mbps. */
  speedInMbps?: number;
  /** BGP settings of the link. */
  bgp?: VpnSiteBgp;
}

export interface VpnSiteProps {
  /** Resource group of the VPN site. Changing it replaces the site. */
  resourceGroup: string;
  /**
   * Name of the VPN site: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the site.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the site.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the virtual WAN the site belongs to. Changing it replaces the
   * site.
   */
  virtualWanId: string;
  /** On-premises address prefixes reachable through the site. */
  addressPrefixes?: string[];
  /**
   * Public IP address of the on-premises VPN device (single-link sites
   * without `links`).
   */
  ipAddress?: string;
  /** Vendor of the on-premises VPN device. */
  deviceVendor?: string;
  /** Model of the on-premises VPN device. */
  deviceModel?: string;
  /** Link speed of the device in Mbps. */
  linkSpeedInMbps?: number;
  /** Site-level BGP settings (single-link sites). */
  bgp?: VpnSiteBgp;
  /** The site's links (multi-link sites). */
  links?: VpnSiteLinkSpec[];
  /** Whether the site is a security site (secured virtual hub). */
  isSecuritySite?: boolean;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VpnSite extends Resource<
  "Azure.Network.VpnSite",
  VpnSiteProps,
  {
    /** Name of the VPN site. */
    vpnSiteName: string;
    /** ARM resource ID of the VPN site. */
    vpnSiteId: string;
    /** Resource group of the VPN site. */
    resourceGroup: string;
    /** Location of the VPN site. */
    location: string;
    /** ARM ID of the virtual WAN. */
    virtualWanId: string | undefined;
    /** On-premises address prefixes. */
    addressPrefixes: string[];
    /** Names of the site's links. */
    linkNames: string[];
    /** ARM IDs of the site's links. */
    linkIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Virtual WAN VPN site — describes an on-premises branch (its VPN
 * device, links, address space, and BGP settings) that a hub VPN gateway
 * connects to. VPN sites are free.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/virtual-wan-site-to-site-portal
 *
 * ### Creating a VPN Site
 * **Example:** Branch with one link
 * ```typescript
 * const site = yield* Azure.Network.VpnSite("branch", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualWanId: wan.virtualWanId,
 *   addressPrefixes: ["10.20.0.0/16"],
 *   links: [
 *     { name: "isp1", ipAddress: "203.0.113.10", providerName: "ISP 1", speedInMbps: 100 },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const VpnSite = Resource<VpnSite>("Azure.Network.VpnSite");

const bgp = (b: VpnSiteBgp | undefined) =>
  b && { asn: b.asn, bgpPeeringAddress: b.bgpPeeringAddress };

export const VpnSiteProvider = () =>
  Provider.succeed(
    VpnSite,
    networkProvider<VpnSite>()({
      label: "VPN site",
      nameAttr: "vpnSiteName",
      tracked: true,
      immutable: (news, output) =>
        output.virtualWanId !== undefined &&
        !sameId(news.virtualWanId, output.virtualWanId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVpnSite({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            vpnSiteName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VpnSitesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          vpnSiteName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVpnSite({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          vpnSiteName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateVpnSiteTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          vpnSiteName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListVpnSites({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          virtualWan: { id: news.virtualWanId },
          addressSpace: news.addressPrefixes && {
            addressPrefixes: news.addressPrefixes,
          },
          ipAddress: news.ipAddress,
          deviceProperties:
            news.deviceVendor !== undefined ||
            news.deviceModel !== undefined ||
            news.linkSpeedInMbps !== undefined
              ? {
                  deviceVendor: news.deviceVendor,
                  deviceModel: news.deviceModel,
                  linkSpeedInMbps: news.linkSpeedInMbps,
                }
              : undefined,
          bgpProperties: bgp(news.bgp),
          isSecuritySite: news.isSecuritySite,
          vpnSiteLinks: news.links?.map((link) => ({
            name: link.name,
            properties: {
              ipAddress: link.ipAddress,
              fqdn: link.fqdn,
              linkProperties:
                link.providerName !== undefined ||
                link.speedInMbps !== undefined
                  ? {
                      linkProviderName: link.providerName,
                      linkSpeedInMbps: link.speedInMbps,
                    }
                  : undefined,
              bgpProperties: bgp(link.bgp),
            },
          })),
        },
      }),
      toAttrs: (path, observed) => ({
        vpnSiteName: path.name,
        vpnSiteId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        virtualWanId: observed.properties?.virtualWan?.id,
        addressPrefixes: [
          ...(observed.properties?.addressSpace?.addressPrefixes ?? []),
        ],
        linkNames: (observed.properties?.vpnSiteLinks ?? []).flatMap((link) =>
          link.name === undefined ? [] : [link.name],
        ),
        linkIds: (observed.properties?.vpnSiteLinks ?? []).flatMap((link) =>
          link.id === undefined ? [] : [link.id],
        ),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.VirtualWan"],
    }),
  );
