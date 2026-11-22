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
  waitNetworkGone,
  waitNetworkProvisioned,
  whileInUse,
  whileNetworkBusy,
} from "./common.ts";

export interface NetworkSecurityGroupProps {
  /**
   * Resource group the NSG is created in. Changing it replaces the NSG.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
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
   * Re-evaluate existing flows when a rule changes (flush connections), so
   * a new deny rule also cuts open connections. Updated in place.
   * @default false
   */
  flushConnection?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface NetworkSecurityGroup extends Resource<
  "Azure.Network.NetworkSecurityGroup",
  NetworkSecurityGroupProps,
  {
    /** Name of the NSG. */
    networkSecurityGroupName: string;
    /**
     * ARM resource ID of the NSG; pass it as `networkSecurityGroupId` to a
     * subnet or network interface.
     */
    networkSecurityGroupId: string;
    /** Resource group that holds the NSG. */
    resourceGroup: string;
    /** Azure location of the NSG, e.g. `eastus`. */
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
 * An Azure network security group
 * (`Microsoft.Network/networkSecurityGroups`), or NSG: a stateful
 * allow/deny firewall for subnets and network interfaces, Azure's
 * counterpart to an AWS security group.
 *
 * A new NSG carries only Azure's default rules: inbound, it allows traffic
 * from the virtual network and the Azure load balancer and denies the
 * rest; outbound, it allows traffic to the virtual network and the
 * internet. Add your own rules with `Azure.Network.SecurityRule`; updating
 * the NSG never removes them. Associate the NSG through
 * `Subnet.networkSecurityGroupId` or
 * `NetworkInterface.networkSecurityGroupId`.
 *
 * :::caution[Changing `name`, `location`, or `resourceGroup` replaces the NSG]
 * Alchemy creates a new NSG and deletes the old one. Rules declared
 * against `nsg.networkSecurityGroupName` are recreated in the new NSG.
 * Until they are, the subnets and network interfaces that use it have
 * only Azure's default rules.
 * :::
 *
 * :::caution[An NSG must be in the same region as its subnets and network interfaces]
 * Set the same `location` on the NSG and the virtual network, or let both
 * use the stack default.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview
 *
 * ### Creating a Network Security Group
 * **Example:** NSG associated with a subnet
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web");
 * const subnet = yield* Azure.Network.Subnet("web", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 * });
 * ```
 *
 * **Example:** NSG with a fixed name and region
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web", {
 *   name: "nsg-web-prod",
 *   location: "westeurope",
 *   tags: { tier: "web" },
 * });
 * ```
 *
 * ### Allowing Inbound Traffic
 * Each rule has a priority from 100 to 4096, unique per direction. Azure
 * evaluates lower numbers first and stops at the first match.
 *
 * **Example:** Allow HTTP and HTTPS from the internet
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web");
 * yield* Azure.Network.SecurityRule("allow-web", {
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 100,
 *   direction: "Inbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   sourceAddressPrefix: "Internet",
 *   destinationPortRanges: ["80", "443"],
 * });
 * ```
 *
 * **Example:** Allow SSH from one office range
 * ```typescript
 * yield* Azure.Network.SecurityRule("allow-ssh", {
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 110,
 *   direction: "Inbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   sourceAddressPrefix: "203.0.113.0/24",
 *   destinationPortRange: "22",
 * });
 * ```
 *
 * ### Restricting Outbound Traffic
 * The default rules allow all outbound internet traffic. Add a deny rule
 * to block it, and an allow rule with a lower number for what the
 * workload needs.
 *
 * **Example:** Allow only Azure Storage outbound
 * ```typescript
 * yield* Azure.Network.SecurityRule("allow-storage", {
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 100,
 *   direction: "Outbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   destinationAddressPrefix: "Storage",
 *   destinationPortRange: "443",
 * });
 * yield* Azure.Network.SecurityRule("deny-internet", {
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 4000,
 *   direction: "Outbound",
 *   access: "Deny",
 *   protocol: "*",
 *   destinationAddressPrefix: "Internet",
 * });
 * ```
 *
 * ### Application Security Groups
 * Group network interfaces by role with an application security group,
 * then write rules against the group instead of IP addresses.
 *
 * **Example:** Let the app tier reach the database tier
 * ```typescript
 * const app = yield* Azure.Network.ApplicationSecurityGroup("app");
 * const db = yield* Azure.Network.ApplicationSecurityGroup("db");
 * const dbNic = yield* Azure.Network.NetworkInterface("db", {
 *   ipConfigurations: [
 *     { subnetId: subnet.subnetId, applicationSecurityGroupIds: [db.applicationSecurityGroupId] },
 *   ],
 * });
 * yield* Azure.Network.SecurityRule("app-to-db", {
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 200,
 *   direction: "Inbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   destinationPortRange: "5432",
 *   sourceApplicationSecurityGroupIds: [app.applicationSecurityGroupId],
 *   destinationApplicationSecurityGroupIds: [db.applicationSecurityGroupId],
 * });
 * ```
 *
 * ### Attaching to a Network Interface
 * An NSG on a network interface filters only that VM's traffic. When
 * both the subnet and the NIC have an NSG, traffic must pass both.
 *
 * **Example:** NSG on a VM's network interface
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("vm");
 * const nic = yield* Azure.Network.NetworkInterface("vm", {
 *   ipConfigurations: [{ subnetId: subnet.subnetId }],
 *   networkSecurityGroupId: nsg.networkSecurityGroupId,
 * });
 * ```
 *
 * ### Flushing Connections on Rule Changes
 * NSG rules are stateful: by default a rule change applies only to new
 * connections. Set `flushConnection: true` to re-evaluate open
 * connections too.
 *
 * **Example:** Cut open connections when a rule changes
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web", {
 *   flushConnection: true,
 * });
 * ```
 *
 * @resource
 */
export const NetworkSecurityGroup = GroupedResource<NetworkSecurityGroup>(
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
      destinationApplicationSecurityGroups: refs(p.destinationApplicationSecurityGroups),
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
      const page = yield* collectAll(network.ListNetworkSecurityGroupAll, { subscriptionId });
      return page.value.flatMap((nsg) => {
        const group = resourceGroupOf(nsg.id);
        return hasAnyAlchemyTag(nsg.tags) && group !== undefined && nsg.name !== undefined
          ? [toAttrs(group, nsg.name, nsg)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.networkSecurityGroupName)) ||
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
      const name = output?.networkSecurityGroupName ?? olds?.name ?? (yield* createNetworkName(id));
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
      const name = news.name ?? output?.networkSecurityGroupName ?? (yield* createNetworkName(id));
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
      observed = yield* waitNetworkProvisioned(`network security group ${name}`, get);
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
        getNsg(subscriptionId, output.resourceGroup, output.networkSecurityGroupName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
