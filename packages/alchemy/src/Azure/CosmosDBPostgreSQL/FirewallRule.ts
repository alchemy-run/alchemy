import * as postgresqlhsc from "@distilled.cloud/azure/postgresqlhsc";
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
import {
  type ClusterRef,
  clusterOwnedByStack,
  COSMOS_POSTGRES_NAMESPACE,
  sameText,
  whileClusterBusy,
} from "./common.ts";

export interface FirewallRuleProps {
  /** Resource group of the cluster. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the cluster. Changing it replaces the rule. */
  cluster: string;
  /**
   * Rule name: letters, digits, `-`, `_`, and `.` (up to 128 characters).
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the rule.
   */
  name?: string;
  /**
   * First IPv4 address of the allowed range. `0.0.0.0` - `0.0.0.0` allows
   * connections from Azure services.
   */
  startIpAddress: string;
  /** Last IPv4 address of the allowed range. */
  endIpAddress: string;
}

export interface FirewallRule extends Resource<
  "Azure.CosmosDBPostgreSQL.FirewallRule",
  FirewallRuleProps,
  {
    /** Name of the rule. */
    firewallRuleName: string;
    /** ARM resource ID of the rule. */
    firewallRuleId: string;
    /** Name of the cluster. */
    cluster: string;
    /** Resource group of the cluster. */
    resourceGroup: string;
    /** First IPv4 address of the allowed range. */
    startIpAddress: string;
    /** Last IPv4 address of the allowed range. */
    endIpAddress: string;
  },
  never,
  Providers
> {}

/**
 * A firewall rule that lets an IPv4 range connect to the public endpoint of
 * an Azure Cosmos DB for PostgreSQL cluster.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/postgresql/concepts-firewall-rules
 *
 * ### Allowing Clients
 * **Example:** Allow an office IP range
 * ```typescript
 * const office = yield* Azure.CosmosDBPostgreSQL.FirewallRule("office", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   startIpAddress: "203.0.113.0",
 *   endIpAddress: "203.0.113.255",
 * });
 * ```
 *
 * **Example:** Allow Azure services
 * ```typescript
 * const azure = yield* Azure.CosmosDBPostgreSQL.FirewallRule("azure", {
 *   resourceGroup: group.resourceGroupName,
 *   cluster: cluster.clusterName,
 *   name: "AllowAllAzureServices",
 *   startIpAddress: "0.0.0.0",
 *   endIpAddress: "0.0.0.0",
 * });
 * ```
 *
 * @resource
 */
export const FirewallRule = Resource<FirewallRule>(
  "Azure.CosmosDBPostgreSQL.FirewallRule",
);

const createRuleName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 80 });
  return name.replace(/[^A-Za-z0-9_.-]/g, "-");
});

interface RuleRef extends ClusterRef {
  readonly firewallRuleName: string;
}

const getRule = (ref: RuleRef) =>
  orUndefinedIfNotFound(postgresqlhsc.GetFirewallRule(ref));

const toAttrs = (
  ref: RuleRef,
  rule: postgresqlhsc.GetFirewallRuleResponse,
): FirewallRule["Attributes"] => ({
  firewallRuleName: ref.firewallRuleName,
  firewallRuleId: rule.id ?? "",
  cluster: ref.clusterName,
  resourceGroup: ref.resourceGroupName,
  startIpAddress: rule.properties.startIpAddress,
  endIpAddress: rule.properties.endIpAddress,
});

export const FirewallRuleProvider = () =>
  Provider.succeed(FirewallRule, {
    stables: ["firewallRuleName", "firewallRuleId", "cluster", "resourceGroup"],

    // Rules live inside a cluster; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.cluster, output.cluster) ||
        (news.name !== undefined && news.name !== output.firewallRuleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const clusterName = output?.cluster ?? olds?.cluster;
      if (resourceGroupName === undefined || clusterName === undefined) {
        return undefined;
      }
      const ref: RuleRef = {
        subscriptionId,
        resourceGroupName,
        clusterName,
        firewallRuleName:
          output?.firewallRuleName ?? olds?.name ?? (yield* createRuleName(id)),
      };
      const observed = yield* getRule(ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      return (yield* clusterOwnedByStack(ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, COSMOS_POSTGRES_NAMESPACE);
      const ref: RuleRef = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        clusterName: news.cluster,
        firewallRuleName:
          news.name ?? output?.firewallRuleName ?? (yield* createRuleName(id)),
      };
      const matches = (rule: postgresqlhsc.GetFirewallRuleResponse) =>
        rule.properties.startIpAddress === news.startIpAddress &&
        rule.properties.endIpAddress === news.endIpAddress;

      // Observe.
      const observed = yield* getRule(ref);

      // Ensure + sync: the PUT is an upsert, so it creates a missing rule
      // and corrects a drifted range alike.
      if (observed === undefined || !matches(observed)) {
        yield* postgresqlhsc
          .FirewallRulesCreateOrUpdate({
            ...ref,
            properties: {
              startIpAddress: news.startIpAddress,
              endIpAddress: news.endIpAddress,
            },
          })
          .pipe(Effect.retry(whileClusterBusy));
      }
      // The PUT is asynchronous; wait until the rule reads back the range.
      const fresh = yield* waitForProvisioned(
        `Cosmos DB for PostgreSQL firewall rule ${ref.firewallRuleName}`,
        getRule(ref),
        (rule) =>
          matches(rule)
            ? (rule.properties.provisioningState ?? "Succeeded")
            : "Updating",
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(ref, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: RuleRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        clusterName: output.cluster,
        firewallRuleName: output.firewallRuleName,
      };
      yield* ignoreNotFound(
        postgresqlhsc
          .DeleteFirewallRule(ref)
          .pipe(Effect.retry(whileClusterBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB for PostgreSQL firewall rule ${output.firewallRuleName}`,
        getRule(ref),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.CosmosDBPostgreSQL.Cluster"] },
  });
