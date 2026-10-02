import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface PublicIpPrefixProps {
  /** Resource group of the prefix. Changing it replaces the prefix. */
  resourceGroup: string;
  /**
   * Name of the prefix: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the prefix.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the prefix.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Prefix length: 28-31 for IPv4 (16 to 2 addresses), 124-127 for IPv6.
   * Changing it replaces the prefix.
   */
  prefixLength: number;
  /**
   * IP version. Changing it replaces the prefix.
   * @default "IPv4"
   */
  publicIpAddressVersion?: "IPv4" | "IPv6";
  /**
   * SKU tier. Changing it replaces the prefix.
   * @default "Regional"
   */
  tier?: "Regional" | "Global";
  /**
   * Availability zones, e.g. `["1", "2", "3"]`. Changing them replaces the
   * prefix.
   * @default no zone
   */
  zones?: string[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface PublicIpPrefix extends Resource<
  "Azure.Network.PublicIpPrefix",
  PublicIpPrefixProps,
  {
    /** Name of the prefix. */
    publicIpPrefixName: string;
    /** ARM resource ID of the prefix. */
    publicIpPrefixId: string;
    /** Resource group of the prefix. */
    resourceGroup: string;
    /** Location of the prefix. */
    location: string;
    /** Allocated CIDR, e.g. `20.1.2.0/31`. */
    ipPrefix: string | undefined;
    /** Prefix length. */
    prefixLength: number | undefined;
    /** IP version. */
    publicIpAddressVersion: string | undefined;
    /** SKU tier. */
    tier: string | undefined;
    /** Availability zones. */
    zones: string[];
    /** IDs of the public IPs allocated from the prefix. */
    publicIpAddressIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure public IP prefix — a reserved, contiguous range of static
 * Standard public IPs. Allocate public IPs from it, or attach it to a NAT
 * gateway or load balancer outbound rule.
 *
 * A prefix bills per IP per hour (~$0.006/IP/h) from creation.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-address-prefix
 *
 * ### Creating a Prefix
 * **Example:** A /31 IPv4 prefix (two addresses)
 * ```typescript
 * const prefix = yield* Azure.Network.PublicIpPrefix("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   prefixLength: 31,
 * });
 * ```
 *
 * **Example:** Use the prefix for NAT gateway SNAT
 * ```typescript
 * yield* Azure.Network.NatGateway("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   publicIpPrefixIds: [prefix.publicIpPrefixId],
 * });
 * ```
 *
 * @resource
 */
export const PublicIpPrefix = Resource<PublicIpPrefix>(
  "Azure.Network.PublicIpPrefix",
);

export const PublicIpPrefixProvider = () =>
  Provider.succeed(
    PublicIpPrefix,
    networkProvider<PublicIpPrefix>()({
      label: "public IP prefix",
      nameAttr: "publicIpPrefixName",
      tracked: true,
      immutable: (news, output) =>
        news.prefixLength !== output.prefixLength ||
        (news.publicIpAddressVersion ?? "IPv4") !==
          output.publicIpAddressVersion ||
        (news.tier ?? "Regional") !== output.tier ||
        !sameSet(news.zones, output.zones),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetPublicIPPrefix({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            publicIpPrefixName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.PublicIPPrefixesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          publicIpPrefixName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeletePublicIPPrefix({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          publicIpPrefixName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdatePublicIPPrefixTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          publicIpPrefixName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListPublicIPPrefixAll({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        sku: { name: "Standard", tier: news.tier ?? "Regional" },
        zones: news.zones,
        properties: {
          prefixLength: news.prefixLength,
          publicIPAddressVersion: news.publicIpAddressVersion ?? "IPv4",
        },
      }),
      // Every field is immutable (replacement); only tags sync in place.
      drifted: () => false,
      toAttrs: (path, observed) => ({
        publicIpPrefixName: path.name,
        publicIpPrefixId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        ipPrefix: observed.properties?.ipPrefix,
        prefixLength: observed.properties?.prefixLength,
        publicIpAddressVersion: observed.properties?.publicIPAddressVersion,
        tier: observed.sku?.tier,
        zones: [...(observed.zones ?? [])],
        publicIpAddressIds: idsOf(observed.properties?.publicIPAddresses),
        tags: userTags(observed.tags),
      }),
    }),
  );
