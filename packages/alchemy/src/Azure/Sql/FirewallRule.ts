import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import { createChildName, lower } from "./common.ts";

export interface FirewallRuleProps {
  /** Resource group of the server. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the rule. */
  server: string;
  /**
   * Rule name (1-128 characters, no `<>*%&:;\/?`, not ending with a
   * period). If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /**
   * First IPv4 address of the allowed range. `0.0.0.0` for both start and
   * end allows connections from Azure services.
   */
  startIpAddress: string;
  /** Last IPv4 address of the allowed range. */
  endIpAddress: string;
}

export interface FirewallRule extends Resource<
  "Azure.Sql.FirewallRule",
  FirewallRuleProps,
  {
    /** Name of the rule. */
    firewallRuleName: string;
    /** ARM resource ID of the rule. */
    firewallRuleId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
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
 * A server-level IPv4 firewall rule on an Azure SQL server. Clients whose
 * address falls in the range may connect to every database on the server.
 *
 * Firewall rules cannot be tagged; Alchemy treats a rule as its own when
 * its name is the one Alchemy generated for this resource (or it was
 * created by a previous deploy).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/firewall-configure
 *
 * ### Allowing Clients
 * **Example:** Allow an office IP range
 * ```typescript
 * yield* Azure.Sql.FirewallRule("office", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   startIpAddress: "203.0.113.0",
 *   endIpAddress: "203.0.113.255",
 * });
 * ```
 *
 * **Example:** Allow Azure services
 * ```typescript
 * yield* Azure.Sql.FirewallRule("azure-services", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   startIpAddress: "0.0.0.0",
 *   endIpAddress: "0.0.0.0",
 * });
 * ```
 *
 * @resource
 */
export const FirewallRule = Resource<FirewallRule>("Azure.Sql.FirewallRule");

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  firewallRuleName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetFirewallRule({
      subscriptionId,
      resourceGroupName,
      serverName,
      firewallRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  name: string,
  rule: sql.GetFirewallRuleResponse,
): FirewallRule["Attributes"] => ({
  firewallRuleName: name,
  firewallRuleId: rule.id ?? "",
  serverName,
  resourceGroup,
  startIpAddress: rule.properties?.startIpAddress ?? "",
  endIpAddress: rule.properties?.endIpAddress ?? "",
});

export const FirewallRuleProvider = () =>
  Provider.succeed(FirewallRule, {
    stables: [
      "firewallRuleName",
      "firewallRuleId",
      "serverName",
      "resourceGroup",
    ],

    // Rules live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        (news.name !== undefined && news.name !== output.firewallRuleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const generated = yield* createChildName(id);
      const name = output?.firewallRuleName ?? olds?.name ?? generated;
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        serverName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, name, observed);
      return output !== undefined || name === generated
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const name =
        news.name ?? output?.firewallRuleName ?? (yield* createChildName(id));
      const get = getRule(subscriptionId, resourceGroup, server, name);

      // Observe, then create or converge the range in one synchronous PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        observed.properties?.startIpAddress !== news.startIpAddress ||
        observed.properties?.endIpAddress !== news.endIpAddress
      ) {
        yield* sql.FirewallRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serverName: server,
          firewallRuleName: name,
          properties: {
            startIpAddress: news.startIpAddress,
            endIpAddress: news.endIpAddress,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql firewall rule ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, server, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteFirewallRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          firewallRuleName: output.firewallRuleName,
        }),
      );
      yield* waitUntilGone(
        `sql firewall rule ${output.firewallRuleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
          output.firewallRuleName,
        ),
      );
    }),
  });
