import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createNetworkName,
  lower,
  parentOwned,
  sameId,
  waitNetworkProvisioned,
  whileNetworkBusy,
} from "./common.ts";

/** One inbound rule opened on the appliance. */
export interface NvaInboundRule {
  /** Name of the rule. */
  name: string;
  /** Protocol. */
  protocol: "TCP" | "UDP";
  /** Source CIDR or IP range. */
  sourceAddressPrefix: string;
  /** Single destination port. */
  destinationPortRange?: number;
  /** Destination port ranges, e.g. `["443", "8000-8080"]`. */
  destinationPortRanges?: string[];
  /**
   * Public IP names (`Permanent` rules) or interface names (`AutoExpire`
   * rules) the rule applies on.
   */
  appliesOn?: string[];
}

export interface NetworkVirtualApplianceInboundSecurityRuleProps {
  /** Resource group of the appliance. Changing it replaces the rule set. */
  resourceGroup: string;
  /**
   * Name of the parent network virtual appliance. Changing it replaces the
   * rule set.
   */
  networkVirtualAppliance: string;
  /**
   * Name of the rule collection. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the rule set.
   */
  name?: string;
  /**
   * `Permanent` creates NSG and load balancer rules (internet ingress);
   * `AutoExpire` creates NSG rules only. Changing it replaces the rule set.
   * @default "Permanent"
   */
  ruleType?: "AutoExpire" | "Permanent";
  /** The rules (authoritative). */
  rules: NvaInboundRule[];
}

export interface NetworkVirtualApplianceInboundSecurityRule extends Resource<
  "Azure.Network.NetworkVirtualApplianceInboundSecurityRule",
  NetworkVirtualApplianceInboundSecurityRuleProps,
  {
    /** Name of the rule collection. */
    ruleCollectionName: string;
    /** ARM resource ID of the rule collection. */
    ruleCollectionId: string;
    /** Name of the parent appliance. */
    networkVirtualAppliance: string;
    /** Resource group of the appliance. */
    resourceGroup: string;
    /** Rule type. */
    ruleType: string | undefined;
    /** Names of the rules currently applied. */
    ruleNames: string[];
  },
  never,
  Providers
> {}

/**
 * Inbound security rules of a network virtual appliance — the NSG (and,
 * for `Permanent` rules, load balancer) rules Azure opens on an NVA in a
 * Virtual WAN hub, e.g. for internet ingress (DNAT) through the appliance.
 * Azure has no DELETE for a rule collection: destroying it clears its
 * rules. Ownership follows the parent appliance.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/how-to-palo-alto-cloud-ngfw
 *
 * ### Opening Ports
 * **Example:** HTTPS ingress through the NVA's public IP
 * ```typescript
 * yield* Azure.Network.NetworkVirtualApplianceInboundSecurityRule("https", {
 *   resourceGroup: group.resourceGroupName,
 *   networkVirtualAppliance: nva.networkVirtualApplianceName,
 *   ruleType: "Permanent",
 *   rules: [
 *     {
 *       name: "https",
 *       protocol: "TCP",
 *       sourceAddressPrefix: "*",
 *       destinationPortRanges: ["443"],
 *       appliesOn: ["nva-ingress-ip"],
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const NetworkVirtualApplianceInboundSecurityRule =
  Resource<NetworkVirtualApplianceInboundSecurityRule>(
    "Azure.Network.NetworkVirtualApplianceInboundSecurityRule",
  );

type Attrs = NetworkVirtualApplianceInboundSecurityRule["Attributes"];

const comparableRules = (
  rules: ReadonlyArray<{
    readonly name?: string;
    readonly protocol?: string;
    readonly sourceAddressPrefix?: string;
    readonly destinationPortRange?: number;
    readonly destinationPortRanges?: ReadonlyArray<string>;
    readonly appliesOn?: ReadonlyArray<string>;
  }>,
) =>
  canonical(
    [...rules]
      .map((r) => ({
        name: r.name,
        protocol: lower(r.protocol),
        sourceAddressPrefix: r.sourceAddressPrefix,
        destinationPortRange: r.destinationPortRange,
        destinationPortRanges: r.destinationPortRanges?.length
          ? [...r.destinationPortRanges].sort()
          : undefined,
        appliesOn: r.appliesOn?.length ? [...r.appliesOn].sort() : undefined,
      }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  );

const toAttrs = (
  resourceGroup: string,
  networkVirtualAppliance: string,
  ruleCollectionName: string,
  observed: network.GetInboundSecurityRuleResponse,
): Attrs => ({
  ruleCollectionName,
  ruleCollectionId: observed.id ?? "",
  networkVirtualAppliance,
  resourceGroup,
  ruleType: observed.properties?.ruleType,
  ruleNames: (observed.properties?.rules ?? []).flatMap((r) =>
    r.name === undefined ? [] : [r.name],
  ),
});

/**
 * The NVA answers "Previous request in-progress" for minutes after it (or a
 * prior rule write) reports `Succeeded`.
 */
const whileNvaBusy = {
  ...whileNetworkBusy,
  schedule: Schedule.spaced("15 seconds"),
  times: 40,
} as const;

export const NetworkVirtualApplianceInboundSecurityRuleProvider = () =>
  Provider.succeed(NetworkVirtualApplianceInboundSecurityRule, {
    stables: [
      "ruleCollectionName",
      "ruleCollectionId",
      "networkVirtualAppliance",
      "resourceGroup",
    ],

    // Rule collections vanish with their appliance.
    list: Effect.fn(function* () {
      return [] as Array<Attrs>;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.networkVirtualAppliance, output.networkVirtualAppliance) ||
        (news.name !== undefined &&
          !sameId(news.name, output.ruleCollectionName)) ||
        (output.ruleType !== undefined &&
          lower(news.ruleType ?? "Permanent") !== lower(output.ruleType))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const nva =
        output?.networkVirtualAppliance ?? olds?.networkVirtualAppliance;
      if (resourceGroup === undefined || nva === undefined) return undefined;
      const name =
        output?.ruleCollectionName ??
        olds?.name ??
        (yield* createNetworkName(id));
      const observed = yield* orUndefinedIfNotFound(
        network.GetInboundSecurityRule({
          subscriptionId,
          resourceGroupName: resourceGroup,
          networkVirtualApplianceName: nva,
          ruleCollectionName: name,
        }),
      );
      if (observed === undefined) return undefined;
      const appliance = yield* orUndefinedIfNotFound(
        network.GetNetworkVirtualAppliance({
          subscriptionId,
          resourceGroupName: resourceGroup,
          networkVirtualApplianceName: nva,
        }),
      );
      const attrs = toAttrs(resourceGroup, nva, name, observed);
      return (yield* parentOwned(appliance?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const path = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        networkVirtualApplianceName: news.networkVirtualAppliance,
        ruleCollectionName:
          output?.ruleCollectionName ??
          news.name ??
          (yield* createNetworkName(id)),
      };
      const get = orUndefinedIfNotFound(network.GetInboundSecurityRule(path));

      // Observe.
      const observed = yield* get;
      const desired = news.rules.map((rule) => ({
        name: rule.name,
        protocol: rule.protocol,
        sourceAddressPrefix: rule.sourceAddressPrefix,
        destinationPortRange: rule.destinationPortRange,
        destinationPortRanges: rule.destinationPortRanges,
        appliesOn: rule.appliesOn,
      }));
      const ruleType = news.ruleType ?? "Permanent";

      // Ensure + sync the whole collection when missing or drifted.
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed" ||
        lower(observed.properties?.ruleType) !== lower(ruleType) ||
        comparableRules(observed.properties?.rules ?? []) !==
          comparableRules(desired)
      ) {
        yield* network
          .InboundSecurityRuleCreateOrUpdate({
            ...path,
            name: path.ruleCollectionName,
            properties: { ruleType, rules: desired },
          })
          .pipe(Effect.retry(whileNvaBusy));
      }
      const final = yield* waitNetworkProvisioned(
        `NVA inbound security rule ${path.ruleCollectionName}`,
        get,
      );
      return toAttrs(
        news.resourceGroup,
        news.networkVirtualAppliance,
        path.ruleCollectionName,
        final,
      );
    }),

    // No DELETE API: clear the collection's rules (gone with the NVA is fine).
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const path = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        networkVirtualApplianceName: output.networkVirtualAppliance,
        ruleCollectionName: output.ruleCollectionName,
      };
      const observed = yield* orUndefinedIfNotFound(
        network.GetInboundSecurityRule(path),
      ).pipe(Effect.retry(whileNvaBusy));
      if (
        observed === undefined ||
        (observed.properties?.rules ?? []).length === 0
      ) {
        return;
      }
      yield* ignoreNotFound(
        network.InboundSecurityRuleCreateOrUpdate({
          ...path,
          name: output.ruleCollectionName,
          properties: { ruleType: observed.properties?.ruleType, rules: [] },
        }),
      ).pipe(Effect.retry(whileNvaBusy));
    }),

    nuke: {
      dependsOn: [
        "Azure.Network.NetworkVirtualAppliance",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
