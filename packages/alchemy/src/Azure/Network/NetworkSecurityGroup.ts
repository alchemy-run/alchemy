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
  waitNetworkGone,
  waitNetworkProvisioned,
  whileInUse,
  whileNetworkBusy,
} from "./common.ts";

export interface NetworkSecurityGroupProps {
  /**
   * Resource group the NSG is created in. Changing it replaces the NSG.
   */
  resourceGroup: string;
  /**
   * Name of the NSG: 1-80 letters, digits, `_`, `.`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the NSG.
   */
  name?: string;
  /**
   * Azure location of the NSG. Changing it replaces the NSG.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Re-evaluate existing flows when a rule changes (flush connections).
   * @default false
   */
  flushConnection?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkSecurityGroup extends Resource<
  "Azure.Network.NetworkSecurityGroup",
  NetworkSecurityGroupProps,
  {
    /** Name of the NSG. */
    networkSecurityGroupName: string;
    /** ARM resource ID of the NSG. */
    networkSecurityGroupId: string;
    /** Resource group that holds the NSG. */
    resourceGroup: string;
    /** Location of the NSG. */
    location: string;
    /** Immutable GUID Azure assigned to the NSG. */
    resourceGuid: string | undefined;
    /** Whether flows are re-evaluated when rules change. */
    flushConnection: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure network security group (NSG) — a stateful allow/deny firewall
 * for subnets and network interfaces. New NSGs carry Azure's default rules
 * (allow VNet and load-balancer traffic, deny other inbound).
 *
 * Custom rules are modelled by `Azure.Network.SecurityRule`; updating the
 * NSG never removes them. Associate the NSG through
 * `Subnet.networkSecurityGroupId` or `NetworkInterface.networkSecurityGroupId`.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview
 *
 * ### Creating a Network Security Group
 * **Example:** NSG associated with a subnet
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const subnet = yield* Azure.Network.Subnet("web", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 * });
 * ```
 *
 * **Example:** NSG that flushes connections on rule changes
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web", {
 *   resourceGroup: group.resourceGroupName,
 *   flushConnection: true,
 *   tags: { tier: "web" },
 * });
 * ```
 *
 * @resource
 */
export const NetworkSecurityGroup = Resource<NetworkSecurityGroup>(
  "Azure.Network.NetworkSecurityGroup",
);

type Observed = network.GetNetworkSecurityGroupResponse;

const getNsg = (
  subscriptionId: string,
  resourceGroupName: string,
  networkSecurityGroupName: string,
) =>
  orUndefinedIfNotFound(
    network.GetNetworkSecurityGroup({
      subscriptionId,
      resourceGroupName,
      networkSecurityGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  nsg: Observed,
): NetworkSecurityGroup["Attributes"] => ({
  networkSecurityGroupName: name,
  networkSecurityGroupId: nsg.id ?? "",
  resourceGroup,
  location: nsg.location ?? "",
  resourceGuid: nsg.properties?.resourceGuid,
  flushConnection: nsg.properties?.flushConnection ?? false,
  tags: userTags(nsg.tags),
});

const refs = (items: ReadonlyArray<{ id?: string }> | undefined) =>
  items?.flatMap((item) => (item.id === undefined ? [] : [{ id: item.id }]));

/** Re-encode an observed security rule as PUT input. */
const ruleInput = (rule: network.SecurityRule_6): network.SecurityRuleInput => {
  const p = rule.properties;
  return {
    id: rule.id,
    name: rule.name,
    properties: p && {
      description: p.description,
      protocol: p.protocol,
      sourcePortRange: p.sourcePortRange,
      destinationPortRange: p.destinationPortRange,
      sourceAddressPrefix: p.sourceAddressPrefix,
      sourceAddressPrefixes: p.sourceAddressPrefixes,
      sourceApplicationSecurityGroups: refs(p.sourceApplicationSecurityGroups),
      destinationAddressPrefix: p.destinationAddressPrefix,
      destinationAddressPrefixes: p.destinationAddressPrefixes,
      destinationApplicationSecurityGroups: refs(
        p.destinationApplicationSecurityGroups,
      ),
      sourcePortRanges: p.sourcePortRanges,
      destinationPortRanges: p.destinationPortRanges,
      access: p.access,
      priority: p.priority,
      direction: p.direction,
    },
  };
};

export const NetworkSecurityGroupProvider = () =>
  Provider.succeed(NetworkSecurityGroup, {
    stables: [
      "networkSecurityGroupName",
      "networkSecurityGroupId",
      "resourceGroup",
      "location",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* network
        .ListNetworkSecurityGroupAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNetworkSecurityGroupAll", page),
          ),
        );
      return page.value.flatMap((nsg) => {
        const group = resourceGroupOf(nsg.id);
        return hasAnyAlchemyTag(nsg.tags) &&
          group !== undefined &&
          nsg.name !== undefined
          ? [toAttrs(group, nsg.name, nsg)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.networkSecurityGroupName)) ||
        (news.location !== undefined && !sameId(news.location, output.location))
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
        output?.networkSecurityGroupName ??
        olds?.name ??
        (yield* createNetworkName(id));
      const observed = yield* getNsg(subscriptionId, resourceGroup, name);
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
        output?.networkSecurityGroupName ??
        (yield* createNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const flushConnection = news.flushConnection ?? false;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkSecurityGroupName: name,
      };
      const get = getNsg(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The PUT replaces the rule collection, so it carries
      // the observed rules (modelled as SecurityRule resources).
      if (
        observed === undefined ||
        (observed.properties?.flushConnection ?? false) !== flushConnection
      ) {
        // Each attempt re-reads the rules: a busy retry with a stale copy
        // would revert a concurrent SecurityRule write.
        yield* Effect.gen(function* () {
          const current = yield* get;
          yield* network.NetworkSecurityGroupsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              flushConnection,
              securityRules: current?.properties?.securityRules?.map(ruleInput),
            },
          });
        }).pipe(Effect.retry(whileNetworkBusy));
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* network
          .UpdateNetworkSecurityGroupTags({ ...where, tags })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(
        `network security group ${name}`,
        get,
      );
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteNetworkSecurityGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          networkSecurityGroupName: output.networkSecurityGroupName,
        }),
      ).pipe(Effect.retry(whileInUse(["NetworkSecurityGroupInUse"])));
      yield* waitNetworkGone(
        `network security group ${output.networkSecurityGroupName}`,
        getNsg(
          subscriptionId,
          output.resourceGroup,
          output.networkSecurityGroupName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
