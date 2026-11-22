import * as mysql from "@distilled.cloud/azure/mysql";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { MYSQL_NAMESPACE, serverOwnedByStack, type ServerRef, whileServerBusy } from "./common.ts";

export interface FirewallRuleProps {
  /**
   * Resource group of the server.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the `Azure.MySQL.FlexibleServer` the rule belongs to.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  server: string;
  /**
   * Rule name: letters, digits, `-`, and `_` (up to 128 characters).
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * First IPv4 address of the allowed range. `0.0.0.0` - `0.0.0.0` allows
   * connections from Azure services. Changing it updates the rule in place.
   */
  startIpAddress: string;
  /**
   * Last IPv4 address of the allowed range. Changing it updates the rule in
   * place.
   */
  endIpAddress: string;
}

export interface FirewallRule extends Resource<
  "Azure.MySQL.FirewallRule",
  FirewallRuleProps,
  {
    /** Name of the rule. */
    firewallRuleName: string;
    /** ARM resource ID of the rule. */
    firewallRuleId: string;
    /** Name of the flexible server. */
    server: string;
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
 * A firewall rule (`Microsoft.DBforMySQL/flexibleServers/firewallRules`)
 * that lets an IPv4 range connect to a public-access Azure Database for
 * MySQL flexible server. A new server has no rules, so it accepts no client
 * until you add one.
 *
 * Rules apply only to servers with public access; VNet-integrated servers
 * reject them.
 *
 * :::caution[Changing `name`, `server`, or `resourceGroup` replaces the rule]
 * Clients in the range lose access for a moment while Alchemy swaps the
 * rule. Changing the IP range updates the rule in place.
 * :::
 *
 * See [Firewall rules in Azure Database for MySQL](https://learn.microsoft.com/azure/mysql/flexible-server/concepts-firewall-rules).
 *
 * ### Allowing Clients
 * **Example:** Allow an office IP range
 * ```typescript
 * const server = yield* Azure.MySQL.FlexibleServer("MySql");
 * yield* Azure.MySQL.FirewallRule("Office", {
 *   server: server.serverName,
 *   startIpAddress: "203.0.113.0",
 *   endIpAddress: "203.0.113.255",
 * });
 * ```
 *
 * **Example:** Allow Azure services
 * ```typescript
 * // Flex Consumption Functions have no fixed outbound IP; this rule lets
 * // any Azure service in. The server still requires TLS and a password.
 * yield* Azure.MySQL.FirewallRule("AllowAzureServices", {
 *   server: server.serverName,
 *   startIpAddress: "0.0.0.0",
 *   endIpAddress: "0.0.0.0",
 * });
 * ```
 *
 * @resource
 */
export const FirewallRule = GroupedResource<FirewallRule>("Azure.MySQL.FirewallRule");

const createRuleName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({ id, maxLength: 80 });
  return name.replace(/[^A-Za-z0-9_-]/g, "-");
});

interface RuleRef extends ServerRef {
  readonly firewallRuleName: string;
}

/** A missing rule answers 404 `FirewallRuleNotExist`. */
const getRule = (ref: RuleRef) =>
  orUndefinedIfNotFound(
    mysql
      .GetFirewallRule(ref)
      .pipe(Effect.catchTag("FirewallRuleNotExist", () => Effect.succeed(undefined))),
  );

const toAttrs = (
  ref: RuleRef,
  rule: mysql.GetFirewallRuleResponse,
): FirewallRule["Attributes"] => ({
  firewallRuleName: ref.firewallRuleName,
  firewallRuleId: rule.id ?? "",
  server: ref.serverName,
  resourceGroup: ref.resourceGroupName,
  startIpAddress: rule.properties.startIpAddress,
  endIpAddress: rule.properties.endIpAddress,
});

const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

export const FirewallRuleProvider = () =>
  Provider.succeed(FirewallRule, {
    stables: ["firewallRuleName", "firewallRuleId", "server", "resourceGroup"],

    // Rules live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.server, output.server) ||
        (news.name !== undefined && news.name !== output.firewallRuleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.server ?? olds?.server;
      if (resourceGroupName === undefined || serverName === undefined) {
        return undefined;
      }
      const ref: RuleRef = {
        subscriptionId,
        resourceGroupName,
        serverName,
        firewallRuleName: output?.firewallRuleName ?? olds?.name ?? (yield* createRuleName(id)),
      };
      const observed = yield* getRule(ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      return (yield* serverOwnedByStack(ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, MYSQL_NAMESPACE);
      const ref: RuleRef = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        serverName: news.server,
        firewallRuleName: news.name ?? output?.firewallRuleName ?? (yield* createRuleName(id)),
      };
      const matches = (rule: mysql.GetFirewallRuleResponse) =>
        rule.properties.startIpAddress === news.startIpAddress &&
        rule.properties.endIpAddress === news.endIpAddress;

      // Observe.
      const observed = yield* getRule(ref);

      // Ensure + sync: the PUT is an upsert, so it creates a missing rule
      // and corrects a drifted range alike.
      if (observed === undefined || !matches(observed)) {
        yield* mysql
          .FirewallRulesCreateOrUpdate({
            ...ref,
            properties: {
              startIpAddress: news.startIpAddress,
              endIpAddress: news.endIpAddress,
            },
          })
          .pipe(Effect.retry(whileServerBusy));
      }
      // The PUT is asynchronous; wait until the rule reads back the range.
      const fresh = yield* waitForProvisioned(
        `MySQL firewall rule ${ref.firewallRuleName}`,
        getRule(ref),
        (rule) => (matches(rule) ? undefined : "Updating"),
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(ref, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: RuleRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.server,
        firewallRuleName: output.firewallRuleName,
      };
      yield* ignoreNotFound(mysql.DeleteFirewallRule(ref).pipe(Effect.retry(whileServerBusy)));
      yield* waitUntilGone(`MySQL firewall rule ${output.firewallRuleName}`, getRule(ref), {
        interval: "5 seconds",
        times: 60,
      });
    }),

    nuke: { dependsOn: ["Azure.MySQL.FlexibleServer"] },
  });
