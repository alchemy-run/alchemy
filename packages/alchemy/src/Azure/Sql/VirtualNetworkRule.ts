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
import { createChildName, lower, sameId } from "./common.ts";

export interface VirtualNetworkRuleProps {
  /** Resource group of the server. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the rule. */
  server: string;
  /**
   * Rule name (1-128 letters, digits, underscores, hyphens, and periods).
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the rule.
   */
  name?: string;
  /**
   * ARM ID of the subnet allowed to reach the server. The subnet should
   * have the `Microsoft.Sql` service endpoint enabled.
   */
  virtualNetworkSubnetId: string;
  /**
   * Create the rule even though the subnet does not have the
   * `Microsoft.Sql` service endpoint yet.
   * @default false
   */
  ignoreMissingVnetServiceEndpoint?: boolean;
}

export interface VirtualNetworkRule extends Resource<
  "Azure.Sql.VirtualNetworkRule",
  VirtualNetworkRuleProps,
  {
    /** Name of the rule. */
    virtualNetworkRuleName: string;
    /** ARM resource ID of the rule. */
    virtualNetworkRuleId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** ARM ID of the allowed subnet. */
    virtualNetworkSubnetId: string;
    /** Rule state, e.g. `Ready`. */
    state: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A virtual network rule on an Azure SQL server: lets clients in a subnet
 * (with the `Microsoft.Sql` service endpoint) connect to the server over
 * the Azure backbone without opening an IP firewall rule.
 *
 * Virtual network rules cannot be tagged; Alchemy treats a rule as its own
 * when its name is the one Alchemy generated for this resource (or it was
 * created by a previous deploy).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/vnet-service-endpoint-rule-overview
 *
 * ### Allowing a Subnet
 * **Example:** Allow a subnet with the SQL service endpoint
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("apps", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   serviceEndpoints: [{ service: "Microsoft.Sql" }],
 * });
 * yield* Azure.Sql.VirtualNetworkRule("apps", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   virtualNetworkSubnetId: subnet.subnetId,
 * });
 * ```
 *
 * **Example:** Create the rule before the service endpoint exists
 * ```typescript
 * yield* Azure.Sql.VirtualNetworkRule("apps", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   virtualNetworkSubnetId: subnetId,
 *   ignoreMissingVnetServiceEndpoint: true,
 * });
 * ```
 *
 * @resource
 */
export const VirtualNetworkRule = Resource<VirtualNetworkRule>(
  "Azure.Sql.VirtualNetworkRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  virtualNetworkRuleName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetVirtualNetworkRule({
      subscriptionId,
      resourceGroupName,
      serverName,
      virtualNetworkRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  name: string,
  rule: sql.GetVirtualNetworkRuleResponse,
): VirtualNetworkRule["Attributes"] => ({
  virtualNetworkRuleName: name,
  virtualNetworkRuleId: rule.id ?? "",
  serverName,
  resourceGroup,
  virtualNetworkSubnetId: rule.properties?.virtualNetworkSubnetId ?? "",
  state: rule.properties?.state,
});

/** Map the rule's `state` to ARM provisioning terms. */
const ruleState = (state: string | undefined) =>
  state === "Ready" || state === undefined
    ? "Succeeded"
    : state === "Failed"
      ? "Failed"
      : state;

export const VirtualNetworkRuleProvider = () =>
  Provider.succeed(VirtualNetworkRule, {
    stables: [
      "virtualNetworkRuleName",
      "virtualNetworkRuleId",
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
        (news.name !== undefined && news.name !== output.virtualNetworkRuleName)
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
      const name = output?.virtualNetworkRuleName ?? olds?.name ?? generated;
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
      const { resourceGroup, server, virtualNetworkSubnetId } = news;
      const ignoreMissing = news.ignoreMissingVnetServiceEndpoint ?? false;
      const name =
        news.name ??
        output?.virtualNetworkRuleName ??
        (yield* createChildName(id));
      const get = getRule(subscriptionId, resourceGroup, server, name);
      const matches = (rule: sql.GetVirtualNetworkRuleResponse) =>
        sameId(rule.properties?.virtualNetworkSubnetId, virtualNetworkSubnetId);

      // Observe, then create or converge the subnet in one long-running PUT.
      const observed = yield* get;
      if (
        observed === undefined ||
        !matches(observed) ||
        (observed.properties?.ignoreMissingVnetServiceEndpoint ?? false) !==
          ignoreMissing
      ) {
        yield* sql.VirtualNetworkRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serverName: server,
          virtualNetworkRuleName: name,
          properties: {
            virtualNetworkSubnetId,
            ignoreMissingVnetServiceEndpoint: ignoreMissing,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `sql virtual network rule ${name}`,
        get,
        (rule) =>
          matches(rule) ? ruleState(rule.properties?.state) : "Updating",
        { interval: "3 seconds", times: 80 },
      );
      return toAttrs(resourceGroup, server, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteVirtualNetworkRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.serverName,
          virtualNetworkRuleName: output.virtualNetworkRuleName,
        }),
      );
      yield* waitUntilGone(
        `sql virtual network rule ${output.virtualNetworkRuleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.serverName,
          output.virtualNetworkRuleName,
        ),
        { interval: "3 seconds", times: 80 },
      );
    }),
  });
