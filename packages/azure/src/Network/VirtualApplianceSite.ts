import * as network from "@distilled.cloud/azure/network";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { networkProvider } from "./generic.ts";

export interface VirtualApplianceSiteProps {
  /** Resource group of the appliance. Changing it replaces the site. */
  resourceGroup: string;
  /**
   * Name of the parent SD-WAN network virtual appliance. Changing it
   * replaces the site.
   */
  networkVirtualAppliance: string;
  /**
   * Name of the site. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the site.
   */
  name?: string;
  /** Address prefix of the branch site, e.g. `"192.168.50.0/24"`. */
  addressPrefix: string;
  /**
   * Microsoft 365 traffic categories that break out locally at the site
   * instead of going through the hub.
   * @default all `false`
   */
  office365Breakout?: {
    /** Break out the `Allow` category. */
    allow?: boolean;
    /** Break out the `Optimize` category. */
    optimize?: boolean;
    /** Break out the `Default` category. */
    default?: boolean;
  };
}

export interface VirtualApplianceSite extends Resource<
  "Azure.Network.VirtualApplianceSite",
  VirtualApplianceSiteProps,
  {
    /** Name of the site. */
    siteName: string;
    /** ARM resource ID of the site. */
    siteId: string;
    /** Name of the parent appliance. */
    networkVirtualAppliance: string;
    /** Resource group of the appliance. */
    resourceGroup: string;
    /** Address prefix of the site. */
    addressPrefix: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A branch site of an SD-WAN {@link NetworkVirtualAppliance} in a Virtual
 * WAN hub (`Microsoft.Network/networkVirtualAppliances/virtualApplianceSites`):
 * the branch's address prefix and its Microsoft 365 local-breakout policy.
 * Sites carry no tags: ownership follows the parent appliance. Sites are
 * free; the appliance bills per scale unit plus the vendor licence.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/about-nva-hub
 *
 * ### Adding a Branch Site
 * **Example:** Branch with Office 365 optimize breakout
 * ```typescript
 * yield* Azure.Network.VirtualApplianceSite("branch-1", {
 *   networkVirtualAppliance: nva.networkVirtualApplianceName,
 *   addressPrefix: "192.168.50.0/24",
 *   office365Breakout: { optimize: true },
 * });
 * ```
 *
 * @resource
 */
export const VirtualApplianceSite = GroupedResource<VirtualApplianceSite>(
  "Azure.Network.VirtualApplianceSite",
);

export const VirtualApplianceSiteProvider = () =>
  Provider.succeed(
    VirtualApplianceSite,
    networkProvider<VirtualApplianceSite>()({
      label: "virtual appliance site",
      nameAttr: "siteName",
      parents: ["networkVirtualAppliance"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualApplianceSite({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkVirtualApplianceName: path.networkVirtualAppliance!,
            siteName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualApplianceSitesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkVirtualApplianceName: path.networkVirtualAppliance!,
          siteName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualApplianceSite({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkVirtualApplianceName: path.networkVirtualAppliance!,
          siteName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkVirtualAppliance({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkVirtualApplianceName: path.networkVirtualAppliance!,
          }),
        ).pipe(Effect.map((nva) => nva?.tags)),
      body: (news) => ({
        properties: {
          addressPrefix: news.addressPrefix,
          o365Policy: {
            breakOutCategories: {
              allow: news.office365Breakout?.allow ?? false,
              optimize: news.office365Breakout?.optimize ?? false,
              default: news.office365Breakout?.default ?? false,
            },
          },
        },
      }),
      toAttrs: (path, observed) => ({
        siteName: path.name,
        siteId: observed.id ?? "",
        networkVirtualAppliance: path.networkVirtualAppliance!,
        resourceGroup: path.resourceGroup,
        addressPrefix: observed.properties?.addressPrefix,
      }),
      dependsOn: ["Azure.Network.NetworkVirtualAppliance"],
    }),
  );
