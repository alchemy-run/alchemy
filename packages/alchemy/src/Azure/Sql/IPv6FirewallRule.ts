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

export interface IPv6FirewallRuleProps {
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
  /** First IPv6 address of the allowed range, e.g. `2001:db8::`. */
  startIPv6Address: string;
  /** Last IPv6 address of the allowed range. */
  endIPv6Address: string;
}

export interface IPv6FirewallRule extends Resource<
  "Azure.Sql.IPv6FirewallRule",
  IPv6FirewallRuleProps,
  {
    /** Name of the rule. */
    firewallRuleName: string;
    /** ARM resource ID of the rule. */
    firewallRuleId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** First IPv6 address of the allowed range. */
    startIPv6Address: string;
    /** Last IPv6 address of the allowed range. */
    endIPv6Address: string;
  },
  never,
  Providers
> {}

/**
 * A server-level IPv6 firewall rule on an Azure SQL server. Clients whose
 * IPv6 address falls in the range may connect to every database on the
 * server. The server must have IPv6 enabled (`isIPv6Enabled: "Enabled"`).
 *
 * Firewall rules cannot be tagged; Alchemy treats a rule as its own when
 * its name is the one Alchemy generated for this resource (or it was
 * created by a previous deploy).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/firewall-configure
 *
 * ### Allowing IPv6 Clients
 * **Example:** Allow an IPv6 range
 * ```typescript
 * const server = yield* Azure.Sql.Server("db", {
 *   resourceGroup: group.resourceGroupName,
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 *   isIPv6Enabled: "Enabled",
 * });
 * yield* Azure.Sql.IPv6FirewallRule("office-v6", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   startIPv6Address: "2001:db8::",
 *   endIPv6Address: "2001:db8::ffff",
 * });
 * ```
 *
 * @resource
 */
export const IPv6FirewallRule = Resource<IPv6FirewallRule>(
  "Azure.Sql.IPv6FirewallRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  firewallRuleName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetIPv6FirewallRule({
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
  rule: sql.GetIPv6FirewallRuleResponse,
): IPv6FirewallRule["Attributes"] => ({
  firewallRuleName: name,
  firewallRuleId: rule.id ?? "",
  serverName,
  resourceGroup,
  startIPv6Address: rule.properties?.startIPv6Address ?? "",
  endIPv6Address: rule.properties?.endIPv6Address ?? "",
});

export const IPv6FirewallRuleProvider = () =>
  Provider.succeed(IPv6FirewallRule, {
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
        lower(observed.properties?.startIPv6Address) !==
          lower(news.startIPv6Address) ||
        lower(observed.properties?.endIPv6Address) !==
          lower(news.endIPv6Address)
      ) {
        yield* sql.IPv6FirewallRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serverName: server,
          firewallRuleName: name,
          properties: {
            startIPv6Address: news.startIPv6Address,
            endIPv6Address: news.endIPv6Address,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql ipv6 firewall rule ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, server, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteIPv6FirewallRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          firewallRuleName: output.firewallRuleName,
        }),
      );
      yield* waitUntilGone(
        `sql ipv6 firewall rule ${output.firewallRuleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
          output.firewallRuleName,
        ),
      );
    }),
  });
