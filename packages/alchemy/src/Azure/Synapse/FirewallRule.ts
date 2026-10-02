import * as synapse from "@distilled.cloud/azure/synapse";
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
import { createChildName, isWorkspaceOwnedByStack, lower } from "./common.ts";

export interface FirewallRuleProps {
  /** Resource group of the workspace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the Synapse workspace. Changing it replaces the rule. */
  workspace: string;
  /**
   * Rule name (letters, digits, `-`, `_`, `.`). Use
   * `AllowAllWindowsAzureIps` with `0.0.0.0`–`0.0.0.0` to allow Azure
   * services. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /** First IPv4 address of the allowed range. */
  startIpAddress: string;
  /** Last IPv4 address of the allowed range (≥ `startIpAddress`). */
  endIpAddress: string;
}

export interface FirewallRule extends Resource<
  "Azure.Synapse.FirewallRule",
  FirewallRuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Name of the workspace. */
    workspaceName: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** First allowed IPv4 address. */
    startIpAddress: string;
    /** Last allowed IPv4 address. */
    endIpAddress: string;
  },
  never,
  Providers
> {}

/**
 * An IP firewall rule on a Synapse workspace — allows a public IPv4 range
 * to reach the workspace's SQL, development, and Studio endpoints.
 *
 * @see https://learn.microsoft.com/azure/synapse-analytics/security/synapse-workspace-ip-firewall
 *
 * ### Allowing Client Addresses
 * **Example:** Allow an office range
 * ```typescript
 * yield* Azure.Synapse.FirewallRule("office", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   startIpAddress: "203.0.113.0",
 *   endIpAddress: "203.0.113.255",
 * });
 * ```
 *
 * **Example:** Allow Azure services
 * ```typescript
 * yield* Azure.Synapse.FirewallRule("azure", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: workspace.workspaceName,
 *   name: "AllowAllWindowsAzureIps",
 *   startIpAddress: "0.0.0.0",
 *   endIpAddress: "0.0.0.0",
 * });
 * ```
 *
 * @resource
 */
export const FirewallRule = Resource<FirewallRule>(
  "Azure.Synapse.FirewallRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  ruleName: string,
) =>
  orUndefinedIfNotFound(
    synapse.GetIpFirewallRule({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      ruleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspaceName: string,
  name: string,
  rule: synapse.GetIpFirewallRuleResponse,
): FirewallRule["Attributes"] => ({
  ruleName: name,
  ruleId: rule.id ?? "",
  workspaceName,
  resourceGroup,
  startIpAddress: rule.properties?.startIpAddress ?? "",
  endIpAddress: rule.properties?.endIpAddress ?? "",
});

export const FirewallRuleProvider = () =>
  Provider.succeed(FirewallRule, {
    stables: ["ruleName", "ruleId", "workspaceName", "resourceGroup"],

    // Rules live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.workspace) !== lower(output.workspaceName) ||
        (news.name !== undefined && news.name !== output.ruleName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspaceName ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.ruleName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      return output !== undefined ||
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          resourceGroup,
          workspace,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Synapse");
      const { resourceGroup, workspace, startIpAddress, endIpAddress } = news;
      const name =
        news.name ?? output?.ruleName ?? (yield* createChildName(id));
      const get = getRule(subscriptionId, resourceGroup, workspace, name);
      const matches = (rule: synapse.GetIpFirewallRuleResponse) =>
        rule.properties?.startIpAddress === startIpAddress &&
        rule.properties?.endIpAddress === endIpAddress;

      // Observe, then create or converge in one long-running PUT.
      const observed = yield* get;
      if (observed === undefined || !matches(observed)) {
        yield* synapse.IpFirewallRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          ruleName: name,
          properties: { startIpAddress, endIpAddress },
        });
      }

      const fresh = yield* waitForProvisioned(
        `synapse firewall rule ${name}`,
        get,
        (rule) =>
          matches(rule) ? rule.properties?.provisioningState : "Updating",
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        synapse.DeleteIpFirewallRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspaceName,
          ruleName: output.ruleName,
        }),
      );
      yield* waitUntilGone(
        `synapse firewall rule ${output.ruleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.workspaceName,
          output.ruleName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
