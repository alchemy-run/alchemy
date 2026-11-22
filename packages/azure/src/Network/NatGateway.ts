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
  createNetworkName,
  sameId,
  sameSet,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileInUse,
  whileNetworkBusy,
} from "./common.ts";

export interface NatGatewayProps {
  /**
   * Resource group the NAT gateway is created in. Changing it replaces the
   * NAT gateway.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the NAT gateway: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the NAT gateway.
   */
  name?: string;
  /**
   * Azure location of the NAT gateway. Changing it replaces the NAT gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * SKU. Changing it replaces the NAT gateway.
   * @default "Standard"
   */
  sku?: "Standard" | "StandardV2";
  /**
   * Availability zone, e.g. `["1"]`. Its public IPs must be in the same
   * zone or zone-redundant. Changing it replaces the NAT gateway.
   * @default no zone (regional)
   */
  zones?: string[];
  /**
   * TCP idle timeout in minutes (4-120). Updated in place.
   * @default 4
   */
  idleTimeoutInMinutes?: number;
  /**
   * ARM IDs of Standard public IPs used for outbound SNAT. Set at least one
   * public IP or prefix; up to 16 IP addresses in total across IPs and
   * prefixes. Updated in place.
   * @default []
   */
  publicIpAddressIds?: string[];
  /**
   * ARM IDs of public IP prefixes used for outbound SNAT. Updated in place.
   * @default []
   */
  publicIpPrefixIds?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface NatGateway extends Resource<
  "Azure.Network.NatGateway",
  NatGatewayProps,
  {
    /** Name of the NAT gateway. */
    natGatewayName: string;
    /** ARM resource ID of the NAT gateway; pass it as a subnet's `natGatewayId`. */
    natGatewayId: string;
    /** Resource group that holds the NAT gateway. */
    resourceGroup: string;
    /** Azure location of the NAT gateway, e.g. `eastus`. */
    location: string;
    /** Immutable GUID Azure assigned to the NAT gateway. */
    resourceGuid: string | undefined;
    /** SKU name: `Standard` or `StandardV2`. */
    sku: string;
    /** Availability zones. */
    zones: string[];
    /** TCP idle timeout in minutes. */
    idleTimeoutInMinutes: number | undefined;
    /** Attached public IP IDs. */
    publicIpAddressIds: string[];
    /** Attached public IP prefix IDs. */
    publicIpPrefixIds: string[];
    /** IDs of the subnets that use this NAT gateway. */
    subnetIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure NAT gateway (`Microsoft.Network/natGateways`): managed
 * outbound internet access (SNAT) for the subnets it is attached to,
 * through static public IPs. Azure's counterpart to an AWS NAT gateway.
 *
 * Every resource in an attached subnet leaves the network from the
 * gateway's public IPs, so partners can allowlist a fixed set of
 * addresses. Inbound connections from the internet are never allowed
 * through it. Attach it to subnets with `Subnet.natGatewayId`. A NAT
 * gateway bills hourly (~$0.045/h) plus processed data.
 *
 * :::caution[Changing `name`, `location`, `resourceGroup`, `sku`, or `zones` replaces the NAT gateway]
 * Alchemy creates a new NAT gateway and deletes the old one. Outbound
 * connections from the attached subnets drop while the subnets move to
 * the new gateway.
 * :::
 *
 * :::caution[Deleting fails while a subnet uses the NAT gateway]
 * Remove `natGatewayId` from the subnets first. Alchemy retries
 * `NatGatewayInUse` for a while, then fails.
 * :::
 *
 * @see https://learn.microsoft.com/azure/nat-gateway/nat-overview
 *
 * ### Creating a NAT Gateway
 * **Example:** NAT gateway with a public IP, attached to a subnet
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("egress");
 * const nat = yield* Azure.Network.NatGateway("egress", {
 *   publicIpAddressIds: [ip.publicIpAddressId],
 * });
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   natGatewayId: nat.natGatewayId,
 * });
 * // ip.ipAddress is the subnet's outbound address
 * ```
 *
 * **Example:** NAT gateway with a fixed name and region
 * ```typescript
 * const nat = yield* Azure.Network.NatGateway("egress", {
 *   name: "ng-egress-prod",
 *   location: "westeurope",
 *   publicIpAddressIds: [ip.publicIpAddressId],
 *   tags: { env: "prod" },
 * });
 * ```
 *
 * ### Idle Timeout
 * The gateway closes idle TCP flows after `idleTimeoutInMinutes` (4-120).
 * Raise it for long-lived connections that send no keepalives.
 *
 * **Example:** 30-minute idle timeout
 * ```typescript
 * const nat = yield* Azure.Network.NatGateway("egress", {
 *   publicIpAddressIds: [ip.publicIpAddressId],
 *   idleTimeoutInMinutes: 30,
 * });
 * ```
 *
 * ### Outbound IP Addresses
 * Each public IP adds 64,512 SNAT ports. Add IPs or a prefix (up to 16
 * addresses in total) when many connections run at once. You can change
 * them in place.
 *
 * **Example:** Two public IPs
 * ```typescript
 * const ip1 = yield* Azure.Network.PublicIpAddress("egress-1");
 * const ip2 = yield* Azure.Network.PublicIpAddress("egress-2");
 * const nat = yield* Azure.Network.NatGateway("egress", {
 *   publicIpAddressIds: [ip1.publicIpAddressId, ip2.publicIpAddressId],
 * });
 * ```
 *
 * **Example:** A /30 prefix that partners can allowlist
 * ```typescript
 * const prefix = yield* Azure.Network.PublicIpPrefix("egress", {
 *   prefixLength: 30,
 * });
 * const nat = yield* Azure.Network.NatGateway("egress", {
 *   publicIpPrefixIds: [prefix.publicIpPrefixId],
 * });
 * // prefix.ipPrefix is the CIDR to allowlist
 * ```
 *
 * ### Availability Zones
 * A NAT gateway runs in one zone or, with no `zones`, in a zone Azure
 * picks. Pin it to a zone with public IPs in the same zone.
 *
 * **Example:** Zonal NAT gateway
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("egress-z1", {
 *   zones: ["1"],
 * });
 * const nat = yield* Azure.Network.NatGateway("egress-z1", {
 *   zones: ["1"],
 *   publicIpAddressIds: [ip.publicIpAddressId],
 * });
 * ```
 *
 * ### Static Egress for Container Apps
 * A workload profiles Container Apps environment in your network sends
 * outbound traffic through the NAT gateway on its infrastructure subnet.
 *
 * **Example:** Container Apps environment with a fixed outbound IP
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("apps", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.2.0/23",
 *   delegations: [{ serviceName: "Microsoft.App/environments" }],
 *   natGatewayId: nat.natGatewayId,
 * });
 * const env = yield* Azure.ContainerApps.ManagedEnvironment("env", {
 *   vnetConfiguration: { infrastructureSubnetId: subnet.subnetId },
 * });
 * ```
 *
 * ### Static Egress for App Service
 * Route all of a Web App's outbound traffic through its integration
 * subnet with `vnetRouteAllEnabled`, and the NAT gateway on that subnet
 * gives the app a fixed outbound IP.
 *
 * **Example:** Web App with a fixed outbound IP
 * ```typescript
 * const subnet = yield* Azure.Network.Subnet("web-out", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.4.0/26",
 *   delegations: [{ serviceName: "Microsoft.Web/serverFarms" }],
 *   natGatewayId: nat.natGatewayId,
 * });
 * const api = yield* Azure.Web.WebApp("Api", {
 *   main: "./src/api.ts",
 *   virtualNetworkSubnetId: subnet.subnetId,
 *   siteConfig: { vnetRouteAllEnabled: true },
 * });
 * ```
 *
 * @resource
 */
export const NatGateway = GroupedResource<NatGateway>("Azure.Network.NatGateway");

type Observed = network.GetNatGatewayResponse;

const getNat = (subscriptionId: string, resourceGroupName: string, natGatewayName: string) =>
  orUndefinedIfNotFound(
    network.GetNatGateway({
      subscriptionId,
      resourceGroupName,
      natGatewayName,
    }),
  );

const ids = (items: ReadonlyArray<{ id?: string }> | undefined) =>
  (items ?? []).flatMap((item) => (item.id === undefined ? [] : [item.id]));

const toAttrs = (resourceGroup: string, name: string, nat: Observed): NatGateway["Attributes"] => ({
  natGatewayName: name,
  natGatewayId: nat.id ?? "",
  resourceGroup,
  location: nat.location ?? "",
  resourceGuid: nat.properties?.resourceGuid,
  sku: nat.sku?.name ?? "",
  zones: [...(nat.zones ?? [])],
  idleTimeoutInMinutes: nat.properties?.idleTimeoutInMinutes,
  publicIpAddressIds: ids(nat.properties?.publicIpAddresses),
  publicIpPrefixIds: ids(nat.properties?.publicIpPrefixes),
  subnetIds: ids(nat.properties?.subnets),
  tags: userTags(nat.tags),
});

export const NatGatewayProvider = () =>
  Provider.succeed(NatGateway, {
    stables: [
      "natGatewayName",
      "natGatewayId",
      "resourceGroup",
      "location",
      "resourceGuid",
      "sku",
      "zones",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(network.ListNatGatewayAll, { subscriptionId });
      return page.value.flatMap((nat) => {
        const group = resourceGroupOf(nat.id);
        return hasAnyAlchemyTag(nat.tags) && group !== undefined && nat.name !== undefined
          ? [toAttrs(group, nat.name, nat)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.natGatewayName)) ||
        (news.location !== undefined && !sameId(news.location, output.location)) ||
        (news.sku ?? "Standard") !== output.sku ||
        !sameSet(news.zones, output.zones)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.natGatewayName ?? olds?.name ?? (yield* createNetworkName(id));
      const observed = yield* getNat(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.natGatewayName ?? (yield* createNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const idleTimeoutInMinutes = news.idleTimeoutInMinutes ?? 4;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        natGatewayName: name,
      };
      const get = getNat(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;
      const props = observed?.properties;

      // Ensure + sync idle timeout and public IP attachments; tag-only
      // drift uses the tags PATCH.
      if (
        observed === undefined ||
        (props?.idleTimeoutInMinutes ?? 4) !== idleTimeoutInMinutes ||
        !sameSet(ids(props?.publicIpAddresses), news.publicIpAddressIds) ||
        !sameSet(ids(props?.publicIpPrefixes), news.publicIpPrefixIds)
      ) {
        yield* network
          .NatGatewaysCreateOrUpdate({
            ...where,
            location,
            tags,
            sku: { name: news.sku ?? "Standard" },
            zones: news.zones,
            properties: {
              idleTimeoutInMinutes,
              publicIpAddresses: (news.publicIpAddressIds ?? []).map((id) => ({
                id,
              })),
              publicIpPrefixes: (news.publicIpPrefixIds ?? []).map((id) => ({
                id,
              })),
              publicIpAddressesV6: props?.publicIpAddressesV6,
              publicIpPrefixesV6: props?.publicIpPrefixesV6,
            },
          })
          .pipe(Effect.retry(whileNetworkBusy));
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* network
          .UpdateNatGatewayTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(`NAT gateway ${name}`, get);
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteNatGateway({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          natGatewayName: output.natGatewayName,
        }),
      ).pipe(Effect.retry(whileInUse(["NatGatewayInUse"])));
      yield* waitNetworkGone(
        `NAT gateway ${output.natGatewayName}`,
        getNat(subscriptionId, output.resourceGroup, output.natGatewayName),
      );
    }),

    // Delete NAT gateways before the public IPs they use.
    nuke: {
      dependsOn: ["Azure.Network.PublicIpAddress", "Azure.Resources.ResourceGroup"],
    },
  });
