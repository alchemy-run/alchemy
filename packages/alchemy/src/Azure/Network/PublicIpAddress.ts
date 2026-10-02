import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createNetworkName,
  ref,
  sameId,
  sameSet,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileInUse,
  whileNetworkBusy,
} from "./common.ts";

export interface PublicIpTag {
  /** Tag type, e.g. `FirstPartyUsage` or `RoutingPreference`. */
  ipTagType: string;
  /** Tag value, e.g. `Internet`. */
  tag: string;
}

export interface PublicIpAddressProps {
  /**
   * Resource group the public IP is created in. Changing it replaces the
   * public IP.
   */
  resourceGroup: string;
  /**
   * Name of the public IP: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the public IP.
   */
  name?: string;
  /**
   * Azure location of the public IP. Changing it replaces the public IP.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * SKU. Basic public IPs were retired in 2025. Changing it replaces the
   * public IP.
   * @default "Standard"
   */
  sku?: "Standard" | "StandardV2";
  /**
   * SKU tier: `Regional`, or `Global` for cross-region load balancers.
   * Changing it replaces the public IP.
   * @default "Regional"
   */
  tier?: "Regional" | "Global";
  /**
   * Availability zones, e.g. `["1"]` (zonal) or `["1", "2", "3"]`
   * (zone-redundant). Changing them replaces the public IP.
   * @default Azure's default for the region
   */
  zones?: string[];
  /**
   * IP version. Changing it replaces the public IP.
   * @default "IPv4"
   */
  ipVersion?: "IPv4" | "IPv6";
  /**
   * Allocation method. Standard SKU requires `Static`. Changing it replaces
   * the public IP.
   * @default "Static"
   */
  allocationMethod?: "Static" | "Dynamic";
  /**
   * ARM ID of a public IP prefix to allocate the address from. Changing it
   * replaces the public IP.
   */
  publicIpPrefixId?: string;
  /**
   * DNS label: the address gets the FQDN
   * `{label}.{location}.cloudapp.azure.com`.
   */
  domainNameLabel?: string;
  /**
   * Reuse policy that hashes the DNS label to make it unique. Changing it
   * replaces the public IP.
   */
  domainNameLabelScope?:
    | "TenantReuse"
    | "SubscriptionReuse"
    | "ResourceGroupReuse"
    | "NoReuse";
  /** Reverse DNS FQDN that resolves back to this address. */
  reverseFqdn?: string;
  /**
   * TCP idle timeout in minutes (4-30).
   * @default 4
   */
  idleTimeoutInMinutes?: number;
  /** IP tags. Changing them replaces the public IP. */
  ipTags?: PublicIpTag[];
  /**
   * What happens to the public IP when the VM using it is deleted.
   * @default Azure's default (`Detach`)
   */
  deleteOption?: "Delete" | "Detach";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PublicIpAddress extends Resource<
  "Azure.Network.PublicIpAddress",
  PublicIpAddressProps,
  {
    /** Name of the public IP. */
    publicIpAddressName: string;
    /** ARM resource ID of the public IP. */
    publicIpAddressId: string;
    /** Resource group that holds the public IP. */
    resourceGroup: string;
    /** Location of the public IP. */
    location: string;
    /** The allocated IP address. */
    ipAddress: string | undefined;
    /** FQDN when a DNS label is set. */
    fqdn: string | undefined;
    /** SKU name. */
    sku: string;
    /** SKU tier. */
    tier: string;
    /** Availability zones. */
    zones: string[];
    /** IP version. */
    ipVersion: string;
    /** Allocation method. */
    allocationMethod: string;
    /** TCP idle timeout in minutes. */
    idleTimeoutInMinutes: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure public IP address — a static internet-facing IPv4 or IPv6
 * address for load balancers, NAT gateways, network interfaces, and
 * gateways. Standard SKU, static allocation by default.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-addresses
 *
 * ### Creating a Public IP
 * **Example:** Standard static IPv4 address
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Address with a DNS label
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress", {
 *   resourceGroup: group.resourceGroupName,
 *   domainNameLabel: "my-app",
 *   idleTimeoutInMinutes: 10,
 * });
 * // ip.fqdn === "my-app.eastus.cloudapp.azure.com"
 * ```
 *
 * ### Zones
 * **Example:** Zonal address
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress", {
 *   resourceGroup: group.resourceGroupName,
 *   zones: ["1"],
 * });
 * ```
 *
 * @resource
 */
export const PublicIpAddress = Resource<PublicIpAddress>(
  "Azure.Network.PublicIpAddress",
);

type Observed = network.GetPublicIPAddressResponse;

const getIp = (
  subscriptionId: string,
  resourceGroupName: string,
  publicIpAddressName: string,
) =>
  orUndefinedIfNotFound(
    network.GetPublicIPAddress({
      subscriptionId,
      resourceGroupName,
      publicIpAddressName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  ip: Observed,
): PublicIpAddress["Attributes"] => ({
  publicIpAddressName: name,
  publicIpAddressId: ip.id ?? "",
  resourceGroup,
  location: ip.location ?? "",
  ipAddress: ip.properties?.ipAddress,
  fqdn: ip.properties?.dnsSettings?.fqdn,
  sku: ip.sku?.name ?? "",
  tier: ip.sku?.tier ?? "",
  zones: [...(ip.zones ?? [])],
  ipVersion: ip.properties?.publicIPAddressVersion ?? "IPv4",
  allocationMethod: ip.properties?.publicIPAllocationMethod ?? "",
  idleTimeoutInMinutes: ip.properties?.idleTimeoutInMinutes,
  tags: userTags(ip.tags),
});

export const PublicIpAddressProvider = () =>
  Provider.succeed(PublicIpAddress, {
    stables: [
      "publicIpAddressName",
      "publicIpAddressId",
      "resourceGroup",
      "location",
      "sku",
      "tier",
      "zones",
      "ipVersion",
      "allocationMethod",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListPublicIPAddressAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPublicIPAddressAll", page),
          ),
        );
      return page.value.flatMap((ip) => {
        const group = resourceGroupOf(ip.id);
        return hasAnyAlchemyTag(ip.tags) &&
          group !== undefined &&
          ip.name !== undefined
          ? [toAttrs(group, ip.name, ip)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.publicIpAddressName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        (news.sku ?? "Standard") !== output.sku ||
        (news.tier ?? "Regional") !== output.tier ||
        (news.zones !== undefined && !sameSet(news.zones, output.zones)) ||
        (news.ipVersion ?? "IPv4") !== output.ipVersion ||
        (news.allocationMethod ?? "Static") !== output.allocationMethod ||
        (olds !== undefined &&
          (!sameId(news.publicIpPrefixId, olds.publicIpPrefixId) ||
            news.domainNameLabelScope !== olds.domainNameLabelScope ||
            canonical(news.ipTags ?? []) !== canonical(olds.ipTags ?? [])))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.publicIpAddressName ??
        olds?.name ??
        (yield* createNetworkName(id));
      const observed = yield* getIp(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.publicIpAddressName ??
        (yield* createNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publicIpAddressName: name,
      };
      const get = getIp(subscriptionId, resourceGroup, name);
      const dnsSettings =
        news.domainNameLabel !== undefined || news.reverseFqdn !== undefined
          ? {
              domainNameLabel: news.domainNameLabel,
              domainNameLabelScope: news.domainNameLabelScope,
              reverseFqdn: news.reverseFqdn,
            }
          : undefined;

      // Observe.
      let observed = yield* get;
      const props = observed?.properties;

      // Ensure + sync mutable aspects (DNS, idle timeout, delete option);
      // tag-only drift uses the tags PATCH.
      const differs =
        observed === undefined ||
        props?.dnsSettings?.domainNameLabel !== news.domainNameLabel ||
        props?.dnsSettings?.reverseFqdn !== news.reverseFqdn ||
        (news.idleTimeoutInMinutes !== undefined &&
          props?.idleTimeoutInMinutes !== news.idleTimeoutInMinutes) ||
        (news.deleteOption !== undefined &&
          props?.deleteOption !== news.deleteOption);
      if (differs) {
        yield* network
          .PublicIPAddressesCreateOrUpdate({
            ...where,
            location,
            tags,
            sku: {
              name: news.sku ?? "Standard",
              tier: news.tier ?? "Regional",
            },
            zones: news.zones ?? observed?.zones,
            properties: {
              publicIPAddressVersion: news.ipVersion ?? "IPv4",
              publicIPAllocationMethod: news.allocationMethod ?? "Static",
              publicIPPrefix: ref(news.publicIpPrefixId),
              dnsSettings,
              idleTimeoutInMinutes: news.idleTimeoutInMinutes,
              ipTags: news.ipTags,
              deleteOption: news.deleteOption ?? props?.deleteOption,
              ddosSettings: props?.ddosSettings,
            },
          })
          .pipe(Effect.retry(whileNetworkBusy));
      } else if (tagsDiffer(observed?.tags, tags)) {
        yield* network
          .UpdatePublicIPAddressTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(`public IP ${name}`, get);
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeletePublicIPAddress({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          publicIpAddressName: output.publicIpAddressName,
        }),
      ).pipe(Effect.retry(whileInUse(["PublicIPAddressInUse"])));
      yield* waitNetworkGone(
        `public IP ${output.publicIpAddressName}`,
        getIp(subscriptionId, output.resourceGroup, output.publicIpAddressName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
