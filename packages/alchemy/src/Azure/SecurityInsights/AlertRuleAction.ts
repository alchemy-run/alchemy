import * as securityinsights from "@distilled.cloud/azure/securityinsights";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  deterministicGuid,
  isWorkspaceOwnedByStack,
  SENTINEL_NAMESPACE,
  sameText,
} from "./Common.ts";

export interface AlertRuleActionProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the action. */
  resourceGroup: string;
  /** Sentinel workspace of the alert rule. Changing it replaces the action. */
  workspace: string;
  /** ID of the parent alert rule (`AlertRule.ruleId`). Changing it replaces the action. */
  ruleId: string;
  /**
   * Action ID. If omitted, a deterministic GUID is derived from the app,
   * stage, and logical ID. Changing it replaces the action.
   */
  actionId?: string;
  /** ARM resource ID of the Logic App playbook (`Logic.Workflow.workflowId`). */
  logicAppResourceId: string;
  /**
   * Callback URL of the playbook's Microsoft Sentinel alert trigger
   * (from `listCallbackUrl`). Write-only; it embeds a SAS signature.
   */
  triggerUri: string | Redacted.Redacted<string>;
}

export interface AlertRuleAction extends Resource<
  "Azure.SecurityInsights.AlertRuleAction",
  AlertRuleActionProps,
  {
    /** Action ID. */
    actionId: string;
    /** ARM resource ID of the action. */
    actionResourceId: string;
    /** Parent alert rule ID. */
    ruleId: string;
    /** Sentinel workspace of the rule. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the playbook. */
    logicAppResourceId: string;
    /** Workflow ID of the playbook as reported by Sentinel. */
    workflowId: string | undefined;
    /** ETag of the action. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Runs a Logic App playbook whenever a Microsoft Sentinel analytics rule
 * raises an alert. The playbook must start with the Microsoft Sentinel
 * alert trigger; pass its callback URL as `triggerUri`.
 *
 * **Deprecated by Microsoft:** the alert rule actions API now rejects
 * every call with `SentinelRuleActionsDeprecated` ("Rules Actions API has
 * been deprecated and is no longer available"). Use an `AutomationRule`
 * with a `RunPlaybook` action instead.
 *
 * @see https://learn.microsoft.com/azure/sentinel/automate-responses-with-playbooks
 *
 * ### Running Playbooks
 * **Example:** Run a playbook on every alert of a rule
 * ```typescript
 * const playbook = yield* Azure.Logic.Workflow("notify", {
 *   resourceGroup: group.resourceGroupName,
 *   definition: sentinelAlertPlaybookDefinition,
 * });
 * yield* Azure.SecurityInsights.AlertRuleAction("notify-on-alert", {
 *   resourceGroup: rule.resourceGroup,
 *   workspace: rule.workspace,
 *   ruleId: rule.ruleId,
 *   logicAppResourceId: playbook.workflowId,
 *   triggerUri: Redacted.make(callbackUrl),
 * });
 * ```
 *
 * @resource
 */
export const AlertRuleAction = Resource<AlertRuleAction>(
  "Azure.SecurityInsights.AlertRuleAction",
);

const reveal = (value: string | Redacted.Redacted<string>) =>
  typeof value === "string" ? value : Redacted.value(value);

const getAction = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  ruleId: string,
  actionId: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetAction({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      ruleId,
      actionId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  ruleId: string,
  actionId: string,
  action: securityinsights.GetActionResponse,
): AlertRuleAction["Attributes"] => ({
  actionId,
  actionResourceId: action.id ?? "",
  ruleId,
  workspace,
  resourceGroup,
  logicAppResourceId: action.properties?.logicAppResourceId ?? "",
  workflowId: action.properties?.workflowId,
  etag: action.etag,
});

export const AlertRuleActionProvider = () =>
  Provider.succeed(AlertRuleAction, {
    stables: [
      "actionId",
      "actionResourceId",
      "ruleId",
      "workspace",
      "resourceGroup",
    ],

    // Actions vanish with their alert rule.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.ruleId, output.ruleId) ||
        (news.actionId !== undefined &&
          !sameText(news.actionId, output.actionId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      const ruleId = output?.ruleId ?? olds?.ruleId;
      if (
        resourceGroup === undefined ||
        workspace === undefined ||
        ruleId === undefined
      ) {
        return undefined;
      }
      const actionId =
        output?.actionId ??
        olds?.actionId ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getAction(
        subscriptionId,
        resourceGroup,
        workspace,
        ruleId,
        actionId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, ruleId, actionId, observed);
      // Actions carry no free text: ownership follows the workspace.
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace, ruleId } = news;
      const actionId =
        news.actionId ??
        output?.actionId ??
        (yield* deterministicGuid(id, instanceId));
      const triggerUri = reveal(news.triggerUri);

      let observed = yield* getAction(
        subscriptionId,
        resourceGroup,
        workspace,
        ruleId,
        actionId,
      );
      // The trigger URI is write-only: olds is the only hint it changed.
      if (
        observed === undefined ||
        !sameText(
          observed.properties?.logicAppResourceId,
          news.logicAppResourceId,
        ) ||
        olds === undefined ||
        reveal(olds.triggerUri) !== triggerUri
      ) {
        observed = yield* securityinsights.ActionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          ruleId,
          actionId,
          etag: observed?.etag,
          properties: {
            logicAppResourceId: news.logicAppResourceId,
            triggerUri,
          },
        });
      }
      return toAttrs(resourceGroup, workspace, ruleId, actionId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteAction({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          ruleId: output.ruleId,
          actionId: output.actionId,
        }),
      );
      yield* waitUntilGone(
        `alert rule action ${output.actionId}`,
        getAction(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.ruleId,
          output.actionId,
        ),
      );
    }),
  });
