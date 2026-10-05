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
import { isServerOwnedByStack, lower } from "./common.ts";
import { serverPath, type ServerScope } from "./setting.ts";

export interface OutboundFirewallRuleProps {
  /** Resource group of the server. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the rule. */
  server: string;
  /**
   * Fully qualified domain name the server may connect to, e.g.
   * `myaccount.blob.core.windows.net`. The FQDN is the rule's name, so
   * changing it replaces the rule.
   */
  fqdn: string;
}

export interface OutboundFirewallRule extends Resource<
  "Azure.Sql.OutboundFirewallRule",
  OutboundFirewallRuleProps,
  {
    /** Allowed FQDN (the rule's name). */
    fqdn: string;
    /** ARM resource ID of the rule. */
    outboundFirewallRuleId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Provisioning state of the rule. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An outbound firewall rule on an Azure SQL server — allows the server to
 * reach one FQDN (e.g. a storage account for auditing or export) when
 * outbound networking is restricted with
 * `restrictOutboundNetworkAccess: "Enabled"` on the server.
 *
 * Rules cannot be tagged; Alchemy treats a rule as its own when its
 * server is owned by the same stack and stage.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/outbound-firewall-rule-overview
 *
 * ### Restricting Outbound Traffic
 * **Example:** Allow a storage account
 * ```typescript
 * const server = yield* Azure.Sql.Server("db", {
 *   resourceGroup: group.resourceGroupName,
 *   administratorLogin: "sqladmin",
 *   administratorLoginPassword: password,
 *   restrictOutboundNetworkAccess: "Enabled",
 * });
 * yield* Azure.Sql.OutboundFirewallRule("audit-storage", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   fqdn: "myauditlogs.blob.core.windows.net",
 * });
 * ```
 *
 * @resource
 */
export const OutboundFirewallRule = Resource<OutboundFirewallRule>(
  "Azure.Sql.OutboundFirewallRule",
);

const getRule = (subscriptionId: string, scope: ServerScope, fqdn: string) =>
  orUndefinedIfNotFound(
    sql.GetOutboundFirewallRule({
      ...serverPath(subscriptionId, scope),
      outboundRuleFqdn: fqdn,
    }),
  );

const toAttrs = (
  scope: ServerScope,
  fqdn: string,
  rule: sql.GetOutboundFirewallRuleResponse,
): OutboundFirewallRule["Attributes"] => ({
  fqdn,
  outboundFirewallRuleId: rule.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  provisioningState: rule.properties?.provisioningState,
});

export const OutboundFirewallRuleProvider = () =>
  Provider.succeed(OutboundFirewallRule, {
    stables: ["fqdn", "outboundFirewallRuleId", "resourceGroup", "serverName"],

    // Rules live inside a server; they are removed with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.fqdn) !== lower(output.fqdn)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      const fqdn = output?.fqdn ?? olds?.fqdn;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        fqdn === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName };
      const observed = yield* getRule(subscriptionId, scope, fqdn);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, fqdn, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: ServerScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
      };
      const get = getRule(subscriptionId, scope, news.fqdn);

      // Observe, then ensure. The rule has no mutable properties.
      const observed = yield* get;
      if (observed === undefined) {
        yield* sql.OutboundFirewallRulesCreateOrUpdate({
          ...serverPath(subscriptionId, scope),
          outboundRuleFqdn: news.fqdn,
        });
      }
      const fresh = yield* waitForProvisioned(
        `sql outbound firewall rule ${news.fqdn}`,
        get,
        (rule) =>
          rule.properties?.provisioningState === "Ready"
            ? "Succeeded"
            : rule.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(scope, news.fqdn, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteOutboundFirewallRule({
          ...serverPath(subscriptionId, output),
          outboundRuleFqdn: output.fqdn,
        }),
      );
      yield* waitUntilGone(
        `sql outbound firewall rule ${output.fqdn}`,
        getRule(subscriptionId, output, output.fqdn),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
