import * as securityinsights from "@distilled.cloud/azure/securityinsights";
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
  compact,
  deterministicGuid,
  isWorkspaceOwnedByStack,
  SENTINEL_NAMESPACE,
  sameText,
  subsetEqual,
} from "./Common.ts";

/** A condition an incident or alert must match for the rule to run. */
export interface AutomationRuleCondition {
  /** Condition type: `Property`, `PropertyArray`, `PropertyChanged`, `PropertyArrayChanged`, or `Boolean`. */
  conditionType:
    | "Property"
    | "PropertyArray"
    | "PropertyChanged"
    | "PropertyArrayChanged"
    | "Boolean"
    | (string & {});
  /**
   * Condition body for the `conditionType`, e.g.
   * `{ propertyName: "IncidentTitle", operator: "Contains", propertyValues: ["x"] }`.
   */
  conditionProperties: Record<string, unknown>;
}

/** When and on what the rule fires. */
export interface AutomationRuleTriggeringLogic {
  /** Whether the rule is enabled. */
  isEnabled: boolean;
  /** UTC time (ISO-8601) after which the rule is disabled automatically. */
  expirationTimeUtc?: string;
  /** Object type that triggers the rule. */
  triggersOn: "Incidents" | "Alerts" | (string & {});
  /** Event that triggers the rule. */
  triggersWhen: "Created" | "Updated" | (string & {});
  /** Conditions that must all match. */
  conditions?: AutomationRuleCondition[];
}

/** An action the rule runs, in `order`. */
export interface AutomationRuleAction {
  /** Execution order of the action within the rule. */
  order: number;
  /** Action type: `ModifyProperties`, `RunPlaybook`, or `AddIncidentTask`. */
  actionType:
    | "ModifyProperties"
    | "RunPlaybook"
    | "AddIncidentTask"
    | (string & {});
  /**
   * Action body for the `actionType`, e.g. `{ severity: "High" }` for
   * `ModifyProperties` or `{ logicAppResourceId, tenantId }` for `RunPlaybook`.
   */
  actionConfiguration: Record<string, unknown>;
}

export interface AutomationRuleProps {
  /** Resource group of the Sentinel workspace. Changing it replaces the rule. */
  resourceGroup: string;
  /**
   * Sentinel-enabled Log Analytics workspace. Pass `OnboardingState.workspace`
   * so the rule is created after onboarding. Changing it replaces the rule.
   */
  workspace: string;
  /**
   * Rule ID (a GUID). If omitted, a deterministic GUID is derived from the
   * app, stage, and logical ID. Changing it replaces the rule.
   */
  automationRuleId?: string;
  /** Display name of the rule. */
  displayName: string;
  /** Execution order among the workspace's automation rules (1–1000). */
  order: number;
  /** Trigger and conditions of the rule. */
  triggeringLogic: AutomationRuleTriggeringLogic;
  /** Actions to run when the rule fires (at least one). */
  actions: AutomationRuleAction[];
}

export interface AutomationRule extends Resource<
  "Azure.SecurityInsights.AutomationRule",
  AutomationRuleProps,
  {
    /** Rule ID (GUID). */
    automationRuleId: string;
    /** ARM resource ID of the rule. */
    automationRuleResourceId: string;
    /** Sentinel workspace of the rule. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Display name of the rule. */
    displayName: string;
    /** Execution order of the rule. */
    order: number;
    /** Creation time (UTC). */
    createdTimeUtc: string | undefined;
    /** Last modification time (UTC). */
    lastModifiedTimeUtc: string | undefined;
    /** ETag of the rule. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Sentinel automation rule: runs actions (change incident
 * properties, add tasks, run a playbook) when incidents or alerts are
 * created or updated and match its conditions.
 *
 * @see https://learn.microsoft.com/azure/sentinel/automate-incident-handling-with-automation-rules
 *
 * ### Triaging Incidents
 * **Example:** Raise severity of matching incidents
 * ```typescript
 * const sentinel = yield* Azure.SecurityInsights.OnboardingState("sentinel", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 * });
 * const rule = yield* Azure.SecurityInsights.AutomationRule("raise", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   displayName: "Raise severity of ransomware incidents",
 *   order: 1,
 *   triggeringLogic: {
 *     isEnabled: true,
 *     triggersOn: "Incidents",
 *     triggersWhen: "Created",
 *     conditions: [
 *       {
 *         conditionType: "Property",
 *         conditionProperties: {
 *           propertyName: "IncidentTitle",
 *           operator: "Contains",
 *           propertyValues: ["ransomware"],
 *         },
 *       },
 *     ],
 *   },
 *   actions: [
 *     {
 *       order: 1,
 *       actionType: "ModifyProperties",
 *       actionConfiguration: { severity: "High" },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Adding Tasks
 * **Example:** Add an investigation task to new incidents
 * ```typescript
 * yield* Azure.SecurityInsights.AutomationRule("task", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   displayName: "Checklist",
 *   order: 2,
 *   triggeringLogic: { isEnabled: true, triggersOn: "Incidents", triggersWhen: "Created" },
 *   actions: [
 *     {
 *       order: 1,
 *       actionType: "AddIncidentTask",
 *       actionConfiguration: { title: "Check sign-in logs" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const AutomationRule = Resource<AutomationRule>(
  "Azure.SecurityInsights.AutomationRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  automationRuleId: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetAutomationRule({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      automationRuleId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  ruleId: string,
  rule: securityinsights.GetAutomationRuleResponse,
): AutomationRule["Attributes"] => ({
  automationRuleId: ruleId,
  automationRuleResourceId: rule.id ?? "",
  workspace,
  resourceGroup,
  displayName: rule.properties.displayName,
  order: rule.properties.order,
  createdTimeUtc: rule.properties.createdTimeUtc,
  lastModifiedTimeUtc: rule.properties.lastModifiedTimeUtc,
  etag: rule.etag,
});

export const AutomationRuleProvider = () =>
  Provider.succeed(AutomationRule, {
    stables: [
      "automationRuleId",
      "automationRuleResourceId",
      "workspace",
      "resourceGroup",
    ],

    // Rules live inside the workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.automationRuleId !== undefined &&
          !sameText(news.automationRuleId, output.automationRuleId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const ruleId =
        output?.automationRuleId ??
        olds?.automationRuleId ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        workspace,
        ruleId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, ruleId, observed);
      // No tags or description: ownership follows the workspace.
      return (yield* isWorkspaceOwnedByStack(
        subscriptionId,
        resourceGroup,
        workspace,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const ruleId =
        news.automationRuleId ??
        output?.automationRuleId ??
        (yield* deterministicGuid(id, instanceId));

      const desired = {
        displayName: news.displayName,
        order: news.order,
        triggeringLogic: compact({ ...news.triggeringLogic }),
        actions: news.actions,
      };

      // Observe; the PUT is a synchronous upsert of the whole rule, sent
      // only when the observed rule differs.
      let observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        workspace,
        ruleId,
      );
      if (
        observed === undefined ||
        !subsetEqual(
          desired,
          observed.properties as unknown as Record<string, unknown>,
        )
      ) {
        observed = yield* securityinsights.AutomationRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          automationRuleId: ruleId,
          etag: observed?.etag,
          properties: desired,
        });
      }
      return toAttrs(resourceGroup, workspace, ruleId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteAutomationRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          automationRuleId: output.automationRuleId,
        }),
      );
      yield* waitUntilGone(
        `automation rule ${output.automationRuleId}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.automationRuleId,
        ),
      );
    }),
  });
