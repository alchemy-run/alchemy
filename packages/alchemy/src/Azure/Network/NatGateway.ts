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
   * Availability zone, e.g. `["1"]`. Changing it replaces the NAT gateway.
   * @default no zone (regional)
   */
  zones?: string[];
  /**
   * TCP idle timeout in minutes (4-120).
   * @default 4
   */
  idleTimeoutInMinutes?: number;
  /**
   * ARM IDs of Standard public IPs used for outbound SNAT. Set at least one
   * public IP or prefix.
   */
  publicIpAddressIds?: string[];
  /** ARM IDs of public IP prefixes used for outbound SNAT. */
  publicIpPrefixIds?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NatGateway extends Resource<
  "Azure.Network.NatGateway",
  NatGatewayProps,
  {
    /** Name of the NAT gateway. */
    natGatewayName: string;
    /** ARM resource ID of the NAT gateway. */
    natGatewayId: string;
    /** Resource group that holds the NAT gateway. */
    resourceGroup: string;
    /** Location of the NAT gateway. */
    location: string;
    /** Immutable GUID Azure assigned to the NAT gateway. */
    resourceGuid: string | undefined;
    /** SKU name. */
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
 * An Azure NAT gateway — managed outbound internet connectivity (SNAT)
 * for the subnets it is attached to, through static public IPs.
 *
 * Attach it to subnets with `Subnet.natGatewayId`. A NAT gateway bills
 * hourly (~$0.045/h) plus processed data.
 *
 * @see https://learn.microsoft.com/azure/nat-gateway/nat-overview
 *
 * ### Creating a NAT Gateway
 * **Example:** NAT gateway with a public IP, attached to a subnet
 * ```typescript
 * const ip = yield* Azure.Network.PublicIpAddress("egress", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const nat = yield* Azure.Network.NatGateway("egress", {
 *   resourceGroup: group.resourceGroupName,
 *   publicIpAddressIds: [ip.publicIpAddressId],
 *   idleTimeoutInMinutes: 10,
 * });
 * const subnet = yield* Azure.Network.Subnet("app", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   natGatewayId: nat.natGatewayId,
 * });
 * ```
 *
 * @resource
 */
export const NatGateway = Resource<NatGateway>("Azure.Network.NatGateway");

type Observed = network.GetNatGatewayResponse;

const getNat = (
  subscriptionId: string,
  resourceGroupName: string,
  natGatewayName: string,
) =>
  orUndefinedIfNotFound(
    network.GetNatGateway({
      subscriptionId,
      resourceGroupName,
      natGatewayName,
    }),
  );

const ids = (items: ReadonlyArray<{ id?: string }> | undefined) =>
  (items ?? []).flatMap((item) => (item.id === undefined ? [] : [item.id]));

const toAttrs = (
  resourceGroup: string,
  name: string,
  nat: Observed,
): NatGateway["Attributes"] => ({
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
      const page = yield* network
        .ListNatGatewayAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNatGatewayAll", page),
          ),
        );
      return page.value.flatMap((nat) => {
        const group = resourceGroupOf(nat.id);
        return hasAnyAlchemyTag(nat.tags) &&
          group !== undefined &&
          nat.name !== undefined
          ? [toAttrs(group, nat.name, nat)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.natGatewayName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
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
      const name =
        output?.natGatewayName ?? olds?.name ?? (yield* createNetworkName(id));
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
      const name =
        news.name ?? output?.natGatewayName ?? (yield* createNetworkName(id));
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
      dependsOn: [
        "Azure.Network.PublicIpAddress",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
