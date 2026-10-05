import * as mongocluster from "@distilled.cloud/azure/mongocluster";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isOwnedChild } from "./Shared.ts";
import { whileMongoClusterBusy } from "./MongoShared.ts";

export interface MongoClusterFirewallRuleProps {
  /** Resource group of the cluster. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the parent cluster, e.g. `cluster.mongoClusterName`. Changing it replaces the rule. */
  cluster: string;
  /**
   * Rule name: letters, digits, `-`, `_`, and `.`, up to 80 characters. A
   * name starting with `AllowAllAzureServicesAndResourcesWithinAzureIps`
   * and a `0.0.0.0` range allows all Azure services. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the rule.
   */
  name?: string;
  /** First IPv4 address of the allowed range. */
  startIpAddress: string;
  /** Last IPv4 address of the allowed range. */
  endIpAddress: string;
}

export interface MongoClusterFirewallRule extends Resource<
  "Azure.CosmosDB.MongoClusterFirewallRule",
  MongoClusterFirewallRuleProps,
  {
    /** Name of the rule. */
    firewallRuleName: string;
    /** ARM resource ID of the rule. */
    firewallRuleId: string;
    /** Name of the parent cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** First IPv4 address of the allowed range. */
    startIpAddress: string;
    /** Last IPv4 address of the allowed range. */
    endIpAddress: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A firewall rule on an Azure Cosmos DB for MongoDB (vCore)
 * {@link MongoCluster}: an IPv4 range allowed to reach the cluster's public
 * endpoint.
 *
 * Firewall rules cannot be tagged; Alchemy treats one it created (or one
 * under a generated name) as its own.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/mongodb/vcore/how-to-configure-firewall
 *
 * ### Allowing Client IPs
 * **Example:** Allow a single address
 * ```typescript
 * const rule = yield* Azure.CosmosDB.MongoClusterFirewallRule("office", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.mongoClusterName,
 *   startIpAddress: "203.0.113.7",
 *   endIpAddress: "203.0.113.7",
 * });
 * ```
 *
 * **Example:** Allow all Azure services
 * ```typescript
 * const rule = yield* Azure.CosmosDB.MongoClusterFirewallRule("azure", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.mongoClusterName,
 *   name: "AllowAllAzureServicesAndResourcesWithinAzureIps_2026",
 *   startIpAddress: "0.0.0.0",
 *   endIpAddress: "0.0.0.0",
 * });
 * ```
 *
 * @resource
 */
export const MongoClusterFirewallRule = Resource<MongoClusterFirewallRule>(
  "Azure.CosmosDB.MongoClusterFirewallRule",
);

const createRuleName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 80 });
  return name.replace(/[^A-Za-z0-9._-]/g, "-");
});

interface RuleRef {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly mongoClusterName: string;
  readonly firewallRuleName: string;
}

const getRule = (ref: RuleRef) =>
  orUndefinedIfNotFound(mongocluster.GetFirewallRule(ref));

type ObservedRule = mongocluster.GetFirewallRuleResponse;

const rangeMatches = (
  rule: ObservedRule,
  props: MongoClusterFirewallRuleProps,
) =>
  rule.properties?.startIpAddress === props.startIpAddress &&
  rule.properties?.endIpAddress === props.endIpAddress;

const toAttrs = (
  resourceGroup: string,
  cluster: string,
  name: string,
  rule: ObservedRule,
): MongoClusterFirewallRule["Attributes"] => ({
  firewallRuleName: name,
  firewallRuleId: rule.id ?? "",
  cluster,
  resourceGroup,
  startIpAddress: rule.properties?.startIpAddress ?? "",
  endIpAddress: rule.properties?.endIpAddress ?? "",
  provisioningState: rule.properties?.provisioningState,
});

export const MongoClusterFirewallRuleProvider = () =>
  Provider.succeed(MongoClusterFirewallRule, {
    stables: ["firewallRuleName", "firewallRuleId", "cluster", "resourceGroup"],

    // Firewall rules disappear with their cluster.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.cluster !== output.cluster ||
        (news.name !== undefined && news.name !== output.firewallRuleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cluster = output?.cluster ?? olds?.cluster;
      if (resourceGroup === undefined || cluster === undefined) {
        return undefined;
      }
      const name =
        output?.firewallRuleName ?? olds?.name ?? (yield* createRuleName(id));
      const observed = yield* getRule({
        subscriptionId,
        resourceGroupName: resourceGroup,
        mongoClusterName: cluster,
        firewallRuleName: name,
      });
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cluster, name, observed);
      return isOwnedChild(output, olds?.name) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, cluster } = news;
      const name =
        news.name ?? output?.firewallRuleName ?? (yield* createRuleName(id));
      const ref: RuleRef = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        mongoClusterName: cluster,
        firewallRuleName: name,
      };
      const get = getRule(ref);

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the range is only settable through the PUT.
      if (observed === undefined || !rangeMatches(observed, news)) {
        yield* mongocluster
          .FirewallRulesCreateOrUpdate({
            ...ref,
            properties: {
              startIpAddress: news.startIpAddress,
              endIpAddress: news.endIpAddress,
            },
          })
          .pipe(Effect.retry(whileMongoClusterBusy));
      }
      const settled = yield* waitForProvisioned(
        `Mongo cluster firewall rule ${name}`,
        get,
        (rule) =>
          rangeMatches(rule, news)
            ? rule.properties?.provisioningState
            : "Updating",
        { interval: "5 seconds", times: 60 },
      );

      return toAttrs(resourceGroup, cluster, name, settled);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: RuleRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        mongoClusterName: output.cluster,
        firewallRuleName: output.firewallRuleName,
      };
      yield* ignoreNotFound(
        mongocluster
          .DeleteFirewallRule(ref)
          .pipe(Effect.retry(whileMongoClusterBusy)),
      );
      yield* waitUntilGone(
        `Mongo cluster firewall rule ${output.firewallRuleName}`,
        getRule(ref),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.MongoCluster",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
