import * as network from "@distilled.cloud/azure/network";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
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
   * ARM ID of a public IP prefix to allocate the address from; the prefix
   * must be in the same region and have the same IP version. Changing it
   * replaces the public IP.
   * @default an address from Azure's pool
   */
  publicIpPrefixId?: string;
  /**
   * DNS label: the address gets the FQDN
   * `{label}.{location}.cloudapp.azure.com`. The label must be unique in
   * the region: 3-63 lowercase letters, digits, and `-`, starting with a
   * letter. Updated in place.
   * @default no DNS name
   */
  domainNameLabel?: string;
  /**
   * Reuse policy that hashes the DNS label to make it unique. Changing it
   * replaces the public IP.
   * @default no hash (the label is used as is)
   */
  domainNameLabelScope?: "TenantReuse" | "SubscriptionReuse" | "ResourceGroupReuse" | "NoReuse";
  /**
   * Reverse DNS FQDN that resolves back to this address (PTR record). The
   * FQDN must resolve forward to this address or to its `fqdn`. Updated
   * in place.
   * @default no reverse DNS
   */
  reverseFqdn?: string;
  /**
   * TCP idle timeout in minutes (4-30). Updated in place.
   * @default 4
   */
  idleTimeoutInMinutes?: number;
  /**
   * IP tags. Changing them replaces the public IP.
   * @default []
   */
  ipTags?: PublicIpTag[];
  /**
   * What happens to the public IP when the VM using it is deleted. Updated
   * in place.
   * @default Azure's default (`Detach`)
   */
  deleteOption?: "Delete" | "Detach";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface PublicIpAddress extends Resource<
  "Azure.Network.PublicIpAddress",
  PublicIpAddressProps,
  {
    /** Name of the public IP. */
    publicIpAddressName: string;
    /**
     * ARM resource ID of the public IP; pass it as `publicIpAddressId` to
     * a network interface or load balancer frontend.
     */
    publicIpAddressId: string;
    /** Resource group that holds the public IP. */
    resourceGroup: string;
    /** Azure location of the public IP, e.g. `eastus`. */
    location: string;
    /** The allocated IP address, e.g. `20.42.0.10`. */
    ipAddress: string | undefined;
    /** FQDN when a DNS label is set, e.g. `my-app.eastus.cloudapp.azure.com`. */
    fqdn: string | undefined;
    /** SKU name: `Standard` or `StandardV2`. */
    sku: string;
    /** SKU tier: `Regional` or `Global`. */
    tier: string;
    /** Availability zones of the address, e.g. `["1", "2", "3"]`. */
    zones: string[];
    /** IP version: `IPv4` or `IPv6`. */
    ipVersion: string;
    /** Allocation method: `Static` or `Dynamic`. */
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
 * An Azure public IP address (`Microsoft.Network/publicIPAddresses`): a
 * static internet-facing IPv4 or IPv6 address for load balancers, NAT
 * gateways, network interfaces, and gateways. Azure's counterpart to an
 * AWS Elastic IP.
 *
 * Alchemy creates a Standard SKU, static address by default. A Standard
 * address is closed to inbound traffic until a network security group
 * allows it. Basic SKU addresses were retired in 2025.
 *
 * :::caution[Changing `name`, `location`, `resourceGroup`, `sku`, `tier`, `zones`, `ipVersion`, `allocationMethod`, `publicIpPrefixId`, `domainNameLabelScope`, or `ipTags` replaces the public IP]
 * Alchemy creates a new address and deletes the old one. The new address
 * has a different IP, so DNS records, firewall allowlists, and partners
 * that pinned the old IP break. Use a DNS label or an alias record to give
 * clients a stable name.
 * :::
 *
 * :::caution[Deleting fails while the address is in use]
 * Detach the address from its network interface, load balancer, or NAT
 * gateway first. Alchemy retries `PublicIPAddressInUse` for a while, then
 * fails.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-network/ip-services/public-ip-addresses
 *
 * ### Creating a Public IP
 * **Example:** Standard static IPv4 address
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress");
 * // ip.ipAddress is the allocated address
 * ```
 *
 * **Example:** Address with a fixed name and region
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress", {
 *   name: "pip-ingress-prod",
 *   location: "westeurope",
 *   tags: { env: "prod" },
 * });
 * ```
 *
 * **Example:** IPv6 address
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress-v6", {
 *   ipVersion: "IPv6",
 * });
 * ```
 *
 * ### DNS Names
 * A DNS label gives the address the FQDN
 * `{label}.{location}.cloudapp.azure.com`. The label must be unique in
 * the region and can change in place.
 *
 * **Example:** Address with a DNS label
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress", {
 *   domainNameLabel: "my-app",
 * });
 * // ip.fqdn === "my-app.eastus.cloudapp.azure.com"
 * ```
 *
 * **Example:** Label hashed for uniqueness, with reverse DNS
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("mail", {
 *   domainNameLabel: "mail",
 *   domainNameLabelScope: "ResourceGroupReuse",
 *   reverseFqdn: "mail.contoso.com",
 * });
 * ```
 *
 * **Example:** Point your own domain at the address
 * ```typescript
 * const zone = yield* Azure.Dns.Zone("contoso", { name: "contoso.com" });
 * yield* Azure.Dns.RecordSet("www", {
 *   zoneName: zone.zoneName,
 *   recordType: "A",
 *   name: "www",
 *   targetResourceId: ip.publicIpAddressId,
 * });
 * ```
 *
 * ### Availability Zones
 * A zonal address lives in one zone. A zone-redundant address survives
 * the loss of a zone. Set `zones` at creation; changing them replaces the
 * address.
 *
 * **Example:** Zonal address
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress", {
 *   zones: ["1"],
 * });
 * ```
 *
 * **Example:** Zone-redundant address
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("ingress", {
 *   zones: ["1", "2", "3"],
 * });
 * ```
 *
 * ### Allocating from a Prefix
 * A public IP prefix reserves a contiguous range. Addresses taken from it
 * are predictable, so a partner can allowlist one CIDR.
 *
 * **Example:** Address from a /28 prefix
 * ```typescript
 * const prefix = yield* Azure.Network.PublicIpPrefix("egress", {
 *   prefixLength: 28,
 * });
 * const ip = yield* Azure.Network.PublicIpAddress("egress-1", {
 *   publicIpPrefixId: prefix.publicIpPrefixId,
 * });
 * ```
 *
 * ### Attaching to a Virtual Machine
 * Associate the address with the VM's network interface, and allow the
 * port in a network security group.
 *
 * **Example:** VM with a public IP
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("vm");
 * const nic = yield* Azure.Network.NetworkInterface("vm", {
 *   ipConfigurations: [
 *     { subnetId: subnet.subnetId, publicIpAddressId: ip.publicIpAddressId },
 *   ],
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 * });
 * const vm = yield* Azure.Compute.VirtualMachine("vm", {
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: ["ssh-ed25519 AAAAC3Nza... me@example.com"],
 * });
 * ```
 *
 * ### Load Balancer and NAT Gateway Frontends
 * A public load balancer receives traffic on the address. A NAT gateway
 * sends a subnet's outbound traffic from it.
 *
 * **Example:** Load balancer frontend
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("lb");
 * const lb = yield* Azure.Network.LoadBalancer("web", {
 *   frontendIpConfigurations: [
 *     { name: "public", publicIpAddressId: ip.publicIpAddressId },
 *   ],
 * });
 * ```
 *
 * **Example:** NAT gateway egress address
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("egress");
 * const nat = yield* Azure.Network.NatGateway("egress", {
 *   publicIpAddressIds: [ip.publicIpAddressId],
 * });
 * ```
 *
 * @resource
 */
export const PublicIpAddress = GroupedResource<PublicIpAddress>("Azure.Network.PublicIpAddress");

type Observed = network.GetPublicIPAddressResponse;

const getIp = (subscriptionId: string, resourceGroupName: string, publicIpAddressName: string) =>
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
      const page = yield* collectAll(network.ListPublicIPAddressAll, { subscriptionId });
      return page.value.flatMap((ip) => {
        const group = resourceGroupOf(ip.id);
        return hasAnyAlchemyTag(ip.tags) && group !== undefined && ip.name !== undefined
          ? [toAttrs(group, ip.name, ip)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.publicIpAddressName)) ||
        (news.location !== undefined && !sameId(news.location, output.location)) ||
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
      const name = output?.publicIpAddressName ?? olds?.name ?? (yield* createNetworkName(id));
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
      const name = news.name ?? output?.publicIpAddressName ?? (yield* createNetworkName(id));
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
        (news.deleteOption !== undefined && props?.deleteOption !== news.deleteOption);
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
