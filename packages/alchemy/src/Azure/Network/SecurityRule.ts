import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNetworkName,
  sameId,
  sameSet,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileNetworkBusy,
} from "./common.ts";

export interface SecurityRuleProps {
  /**
   * Resource group of the network security group. Changing it replaces the
   * rule.
   */
  resourceGroup: string;
  /** Name of the parent network security group. Changing it replaces the rule. */
  networkSecurityGroup: string;
  /**
   * Name of the rule: 1-80 letters, digits, `_`, `.`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the rule.
   */
  name?: string;
  /**
   * Priority between 100 and 4096, unique per direction within the NSG.
   * Lower numbers are evaluated first.
   */
  priority: number;
  /** Whether the rule applies to inbound or outbound traffic. */
  direction: "Inbound" | "Outbound";
  /** Whether matching traffic is allowed or denied. */
  access: "Allow" | "Deny";
  /** Network protocol the rule matches. `*` matches any protocol. */
  protocol: "Tcp" | "Udp" | "Icmp" | "Esp" | "Ah" | "*";
  /**
   * Source port or range, e.g. `*` or `1024-65535`.
   * @default "*" (when `sourcePortRanges` is unset)
   */
  sourcePortRange?: string;
  /** Multiple source ports or ranges. */
  sourcePortRanges?: string[];
  /**
   * Destination port or range, e.g. `443` or `8000-8999`.
   * @default "*" (when `destinationPortRanges` is unset)
   */
  destinationPortRange?: string;
  /** Multiple destination ports or ranges. */
  destinationPortRanges?: string[];
  /**
   * Source CIDR, IP, or service tag (`VirtualNetwork`, `Internet`,
   * `AzureLoadBalancer`, ...).
   * @default "*" (when no other source is set)
   */
  sourceAddressPrefix?: string;
  /** Multiple source CIDRs or IPs. */
  sourceAddressPrefixes?: string[];
  /** ARM IDs of application security groups to match as source. */
  sourceApplicationSecurityGroupIds?: string[];
  /**
   * Destination CIDR, IP, or service tag.
   * @default "*" (when no other destination is set)
   */
  destinationAddressPrefix?: string;
  /** Multiple destination CIDRs or IPs. */
  destinationAddressPrefixes?: string[];
  /** ARM IDs of application security groups to match as destination. */
  destinationApplicationSecurityGroupIds?: string[];
  /**
   * Description shown in the portal. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`); the whole value is limited to 140
   * characters.
   */
  description?: string;
}

export interface SecurityRule extends Resource<
  "Azure.Network.SecurityRule",
  SecurityRuleProps,
  {
    /** Name of the rule. */
    securityRuleName: string;
    /** ARM resource ID of the rule. */
    securityRuleId: string;
    /** Name of the parent network security group. */
    networkSecurityGroup: string;
    /** Resource group of the network security group. */
    resourceGroup: string;
    /** Priority of the rule. */
    priority: number;
    /** Direction of the rule. */
    direction: string;
    /** Access of the rule. */
    access: string;
    /** Protocol of the rule. */
    protocol: string;
    /** User description (ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A security rule in an Azure network security group (NSG). Rules allow or
 * deny traffic by direction, protocol, ports, and source / destination
 * (CIDRs, service tags, or application security groups).
 *
 * Model each rule as its own resource; the NSG keeps them when it updates.
 * Rules of one NSG are written one at a time by Azure; the provider
 * retries `AnotherOperationInProgress` so rules can be declared side by
 * side.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/network-security-groups-overview
 *
 * ### Creating a Security Rule
 * **Example:** Allow HTTPS from the internet
 * ```typescript
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Network.SecurityRule("allow-https", {
 *   resourceGroup: group.resourceGroupName,
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 100,
 *   direction: "Inbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   sourceAddressPrefix: "Internet",
 *   destinationPortRange: "443",
 * });
 * ```
 *
 * ### Targeting Application Security Groups
 * **Example:** Allow the app tier to reach the database tier
 * ```typescript
 * yield* Azure.Network.SecurityRule("app-to-db", {
 *   resourceGroup: group.resourceGroupName,
 *   networkSecurityGroup: nsg.networkSecurityGroupName,
 *   priority: 200,
 *   direction: "Inbound",
 *   access: "Allow",
 *   protocol: "Tcp",
 *   destinationPortRanges: ["5432", "6432"],
 *   sourceApplicationSecurityGroupIds: [app.applicationSecurityGroupId],
 *   destinationApplicationSecurityGroupIds: [db.applicationSecurityGroupId],
 * });
 * ```
 *
 * @resource
 */
export const SecurityRule = Resource<SecurityRule>(
  "Azure.Network.SecurityRule",
);

type Observed = network.GetSecurityRuleResponse;

const MARKER = /\s*\[alchemy [^\]]+\]$/;

const ownershipMarker = Effect.fn(function* (id: string) {
  const { stack, stage } = yield* stackAndStage;
  return `[alchemy ${stack}/${stage}/${id}]`;
});

const userDescription = (description: string | undefined) => {
  const stripped = description?.replace(MARKER, "");
  return stripped ? stripped : undefined;
};

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  networkSecurityGroupName: string,
  securityRuleName: string,
) =>
  orUndefinedIfNotFound(
    network.GetSecurityRule({
      subscriptionId,
      resourceGroupName,
      networkSecurityGroupName,
      securityRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  networkSecurityGroup: string,
  name: string,
  rule: Observed,
): SecurityRule["Attributes"] => ({
  securityRuleName: name,
  securityRuleId: rule.id ?? "",
  networkSecurityGroup,
  resourceGroup,
  priority: rule.properties?.priority ?? 0,
  direction: rule.properties?.direction ?? "",
  access: rule.properties?.access ?? "",
  protocol: rule.properties?.protocol ?? "",
  description: userDescription(rule.properties?.description),
});

const hasAny = (values: ReadonlyArray<string> | undefined) =>
  values !== undefined && values.length > 0;

/** Desired rule properties; `*` fills an unset single-value field. */
const desiredProperties = (news: SecurityRuleProps, description: string) => {
  const sourceAsgs = news.sourceApplicationSecurityGroupIds ?? [];
  const destinationAsgs = news.destinationApplicationSecurityGroupIds ?? [];
  return {
    description,
    priority: news.priority,
    direction: news.direction,
    access: news.access,
    protocol: news.protocol,
    sourcePortRange: hasAny(news.sourcePortRanges)
      ? undefined
      : (news.sourcePortRange ?? "*"),
    sourcePortRanges: news.sourcePortRanges ?? [],
    destinationPortRange: hasAny(news.destinationPortRanges)
      ? undefined
      : (news.destinationPortRange ?? "*"),
    destinationPortRanges: news.destinationPortRanges ?? [],
    sourceAddressPrefix:
      hasAny(news.sourceAddressPrefixes) || sourceAsgs.length > 0
        ? news.sourceAddressPrefix
        : (news.sourceAddressPrefix ?? "*"),
    sourceAddressPrefixes: news.sourceAddressPrefixes ?? [],
    sourceApplicationSecurityGroups: sourceAsgs.map((id) => ({ id })),
    destinationAddressPrefix:
      hasAny(news.destinationAddressPrefixes) || destinationAsgs.length > 0
        ? news.destinationAddressPrefix
        : (news.destinationAddressPrefix ?? "*"),
    destinationAddressPrefixes: news.destinationAddressPrefixes ?? [],
    destinationApplicationSecurityGroups: destinationAsgs.map((id) => ({
      id,
    })),
  };
};

const asgIds = (
  groups: ReadonlyArray<{ readonly id?: string }> | undefined,
) => (groups ?? []).flatMap((group) => (group.id ? [group.id] : []));

export const SecurityRuleProvider = () =>
  Provider.succeed(SecurityRule, {
    stables: [
      "securityRuleName",
      "securityRuleId",
      "networkSecurityGroup",
      "resourceGroup",
    ],

    // Rules live inside a network security group; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.networkSecurityGroup, output.networkSecurityGroup) ||
        (news.name !== undefined && !sameId(news.name, output.securityRuleName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const nsg = output?.networkSecurityGroup ?? olds?.networkSecurityGroup;
      if (resourceGroup === undefined || nsg === undefined) return undefined;
      const name =
        output?.securityRuleName ?? olds?.name ?? (yield* createNetworkName(id));
      const observed = yield* getRule(subscriptionId, resourceGroup, nsg, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, nsg, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.description ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, networkSecurityGroup } = news;
      const name =
        news.name ?? output?.securityRuleName ?? (yield* createNetworkName(id));
      const marker = yield* ownershipMarker(id);
      const description = news.description
        ? `${news.description} ${marker}`
        : marker;
      const desired = desiredProperties(news, description);
      const get = getRule(
        subscriptionId,
        resourceGroup,
        networkSecurityGroup,
        name,
      );

      // Observe.
      let observed = yield* get;
      const p = observed?.properties;

      // Ensure + sync: the rule is one PUT; skip it when nothing drifted.
      const differs =
        observed === undefined ||
        p?.description !== desired.description ||
        p?.priority !== desired.priority ||
        p?.direction !== desired.direction ||
        p?.access !== desired.access ||
        p?.protocol !== desired.protocol ||
        p?.sourcePortRange !== desired.sourcePortRange ||
        !sameSet(p?.sourcePortRanges, desired.sourcePortRanges) ||
        p?.destinationPortRange !== desired.destinationPortRange ||
        !sameSet(p?.destinationPortRanges, desired.destinationPortRanges) ||
        p?.sourceAddressPrefix !== desired.sourceAddressPrefix ||
        !sameSet(p?.sourceAddressPrefixes, desired.sourceAddressPrefixes) ||
        p?.destinationAddressPrefix !== desired.destinationAddressPrefix ||
        !sameSet(
          p?.destinationAddressPrefixes,
          desired.destinationAddressPrefixes,
        ) ||
        !sameSet(
          asgIds(p?.sourceApplicationSecurityGroups),
          news.sourceApplicationSecurityGroupIds,
        ) ||
        !sameSet(
          asgIds(p?.destinationApplicationSecurityGroups),
          news.destinationApplicationSecurityGroupIds,
        );
      if (differs) {
        yield* network
          .SecurityRulesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            networkSecurityGroupName: networkSecurityGroup,
            securityRuleName: name,
            properties: desired,
          })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      observed = yield* waitNetworkProvisioned(
        `security rule ${networkSecurityGroup}/${name}`,
        get,
      );
      return toAttrs(resourceGroup, networkSecurityGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.DeleteSecurityRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          networkSecurityGroupName: output.networkSecurityGroup,
          securityRuleName: output.securityRuleName,
        }),
      ).pipe(Effect.retry(whileNetworkBusy));
      yield* waitNetworkGone(
        `security rule ${output.networkSecurityGroup}/${output.securityRuleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.networkSecurityGroup,
          output.securityRuleName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Network.NetworkSecurityGroup",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
