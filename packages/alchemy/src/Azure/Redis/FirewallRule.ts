import * as redis from "@distilled.cloud/azure/redis";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  cacheOwnedByStage,
  createAlphanumericName,
  lower,
  whileCacheBusy,
} from "./Common.ts";

export interface FirewallRuleProps {
  /** Resource group of the cache. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the `Azure.Redis.Cache`. Changing it replaces the rule. */
  cache: string;
  /**
   * Rule name: letters, digits, and underscores. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the rule.
   */
  name?: string;
  /** Lowest IPv4 address of the allowed range, e.g. `203.0.113.0`. */
  startIP: string;
  /** Highest IPv4 address of the allowed range, e.g. `203.0.113.255`. */
  endIP: string;
}

export interface FirewallRule extends Resource<
  "Azure.Redis.FirewallRule",
  FirewallRuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Name of the cache. */
    cache: string;
    /** Resource group of the cache. */
    resourceGroup: string;
    /** Lowest IPv4 address of the allowed range. */
    startIP: string;
    /** Highest IPv4 address of the allowed range. */
    endIP: string;
  },
  never,
  Providers
> {}

/**
 * An IP range allowed to reach an `Azure.Redis.Cache` over its public
 * endpoint. Once a cache has any firewall rule, only addresses inside a
 * rule may connect.
 *
 * Rules have no tags; they belong to the stage that owns their cache.
 *
 * @see https://learn.microsoft.com/azure/azure-cache-for-redis/cache-configure#firewall
 *
 * ### Allowing Clients
 * **Example:** Allow a single office range
 * ```typescript
 * const cache = yield* Azure.Redis.Cache("cache", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Redis.FirewallRule("office", {
 *   resourceGroup: group.resourceGroupName,
 *   cache: cache.cacheName,
 *   startIP: "203.0.113.0",
 *   endIP: "203.0.113.255",
 * });
 * ```
 *
 * **Example:** Allow one address with an explicit rule name
 * ```typescript
 * yield* Azure.Redis.FirewallRule("ci", {
 *   resourceGroup: group.resourceGroupName,
 *   cache: cache.cacheName,
 *   name: "ci_runner",
 *   startIP: "198.51.100.7",
 *   endIP: "198.51.100.7",
 * });
 * ```
 *
 * @resource
 */
export const FirewallRule = Resource<FirewallRule>("Azure.Redis.FirewallRule");

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  cacheName: string,
  ruleName: string,
) =>
  orUndefinedIfNotFound(
    redis.GetFirewallRule({
      subscriptionId,
      resourceGroupName,
      cacheName,
      ruleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  cache: string,
  name: string,
  rule: redis.GetFirewallRuleResponse,
): FirewallRule["Attributes"] => ({
  ruleName: name,
  ruleId: rule.id ?? "",
  cache,
  resourceGroup,
  startIP: rule.properties.startIP,
  endIP: rule.properties.endIP,
});

export const FirewallRuleProvider = () =>
  Provider.succeed(FirewallRule, {
    stables: ["ruleName", "ruleId", "cache", "resourceGroup"],

    // Rules live inside a cache; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.cache) !== lower(output.cache) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.ruleName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const cache = output?.cache ?? olds?.cache;
      if (resourceGroup === undefined || cache === undefined) return undefined;
      const name =
        output?.ruleName ?? olds?.name ?? (yield* createAlphanumericName(id, 60));
      const observed = yield* getRule(subscriptionId, resourceGroup, cache, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, cache, name, observed);
      return (yield* cacheOwnedByStage(subscriptionId, resourceGroup, cache))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cache");
      const { resourceGroup, cache } = news;
      const name =
        news.name ?? output?.ruleName ?? (yield* createAlphanumericName(id, 60));

      // Observe.
      let observed = yield* getRule(subscriptionId, resourceGroup, cache, name);

      // Ensure + sync: PUT is an upsert; send it only when the range differs.
      if (
        observed === undefined ||
        observed.properties.startIP !== news.startIP ||
        observed.properties.endIP !== news.endIP
      ) {
        yield* redis
          .FirewallRulesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            cacheName: cache,
            ruleName: name,
            properties: { startIP: news.startIP, endIP: news.endIP },
          })
          .pipe(Effect.retry(whileCacheBusy));
        observed = yield* redis.GetFirewallRule({
          subscriptionId,
          resourceGroupName: resourceGroup,
          cacheName: cache,
          ruleName: name,
        });
      }
      return toAttrs(resourceGroup, cache, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        redis
          .DeleteFirewallRule({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            cacheName: output.cache,
            ruleName: output.ruleName,
          })
          .pipe(Effect.retry(whileCacheBusy)),
      );
      yield* waitUntilGone(
        `redis firewall rule ${output.ruleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.cache,
          output.ruleName,
        ),
        { interval: "5 seconds", times: 40 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Redis.Cache", "Azure.Resources.ResourceGroup"],
    },
  });
