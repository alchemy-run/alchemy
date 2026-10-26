import * as alertsmanagement from "@distilled.cloud/azure/alertsmanagement";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

/** What an alert processing rule does to the alerts it matches. */
export type AlertProcessingRuleAction =
  | {
      /** Suppress notifications: remove every action group from the alert. */
      actionType: "RemoveAllActionGroups";
    }
  | {
      /** Add action groups to the alert. */
      actionType: "AddActionGroups";
      /** ARM resource IDs of the action groups to add. */
      actionGroupIds: string[];
    };

/** One filter on the alerts a rule processes. */
export interface AlertProcessingRuleCondition {
  /**
   * Alert field to filter on, e.g. `Severity`, `AlertRuleName`,
   * `TargetResourceType`, `MonitorService`, `SignalType`.
   */
  field:
    | "Severity"
    | "MonitorService"
    | "MonitorCondition"
    | "SignalType"
    | "TargetResourceType"
    | "TargetResource"
    | "TargetResourceGroup"
    | "AlertRuleId"
    | "AlertRuleName"
    | "Description"
    | "AlertContext";
  /** Comparison operator. */
  operator: "Equals" | "NotEquals" | "Contains" | "DoesNotContain";
  /** Values to match (any of them), e.g. `["Sev0", "Sev1"]`. */
  values: string[];
}

/** A recurring window, inside the effective window, when the rule is active. */
export interface AlertProcessingRuleRecurrence {
  /** Recurrence cadence: `Daily`, `Weekly`, or `Monthly`. */
  recurrenceType: "Daily" | "Weekly" | "Monthly";
  /**
   * Start time of each day's window, `HH:mm:ss` in `timeZone`.
   * @default not set (the whole day)
   */
  startTime?: string;
  /**
   * End time of each day's window, `HH:mm:ss` in `timeZone`.
   * @default not set (the whole day)
   */
  endTime?: string;
  /**
   * Days of the week (`Weekly` only), e.g. `["Saturday", "Sunday"]`.
   * @default none
   */
  daysOfWeek?: string[];
  /**
   * Days of the month (`Monthly` only), 1–31.
   * @default none
   */
  daysOfMonth?: number[];
}

/** When an alert processing rule is active. */
export interface AlertProcessingRuleSchedule {
  /**
   * Start of the effective window, ISO 8601 without a timezone suffix,
   * e.g. `2026-12-24T18:00:00`.
   * @default not set (in effect from creation)
   */
  effectiveFrom?: string;
  /**
   * End of the effective window, ISO 8601 without a timezone suffix.
   * @default not set (no end)
   */
  effectiveUntil?: string;
  /**
   * Windows time zone name, e.g. `UTC` or `Pacific Standard Time`.
   * @default not set (Azure's default)
   */
  timeZone?: string;
  /**
   * Recurring windows inside the effective window.
   * @default none (active for the whole effective window)
   */
  recurrences?: AlertProcessingRuleRecurrence[];
}

export interface AlertProcessingRuleProps {
  /**
   * Resource group the rule is created in.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Rule name, up to 64 characters.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * ARM IDs of the subscriptions, resource groups, or resources whose alerts
   * the rule processes, e.g. `[group.resourceGroupId]`.
   */
  scopes: string[];
  /**
   * Action applied to matching alerts: exactly one entry,
   * `RemoveAllActionGroups` or `AddActionGroups`.
   */
  actions: AlertProcessingRuleAction[];
  /**
   * Filters that select which alerts the rule applies to (all must match).
   * @default [] (every alert in `scopes`)
   */
  conditions?: AlertProcessingRuleCondition[];
  /**
   * When the rule is active.
   * @default always active
   */
  schedule?: AlertProcessingRuleSchedule;
  /**
   * Description of the rule.
   * @default no description
   */
  description?: string;
  /**
   * Whether the rule is applied.
   * @default true
   */
  enabled?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface AlertProcessingRule extends Resource<
  "Azure.Monitor.AlertProcessingRule",
  AlertProcessingRuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** Resource group that holds the rule. */
    resourceGroup: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Scopes the rule applies to. */
    scopes: string[];
    /** Whether the rule is enabled. */
    enabled: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor alert processing rule
 * (`Microsoft.AlertsManagement/actionRules`, formerly action rule): it
 * suppresses notifications or adds action groups to fired alerts that match
 * its scope, filters, and schedule. Use it for planned maintenance windows,
 * quiet weekends, or to send every critical alert to on-call. Rules are
 * global resources (location `global`) and cost nothing.
 *
 * :::caution[Changing `name` or `resourceGroup` replaces the rule]
 * Alchemy creates a new rule and deletes the old one.
 * :::
 *
 * :::caution[`AddActionGroups` needs an existing action group]
 * Alchemy has no action group resource yet. Create the action group
 * (`Microsoft.Insights/actionGroups`) outside Alchemy and pass its ARM ID.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-processing-rules
 *
 * ### Suppressing Notifications
 * **Example:** Silence low-severity alerts in a resource group on weekends
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const rule = yield* Azure.Monitor.AlertProcessingRule("weekend-quiet", {
 *   scopes: [group.resourceGroupId],
 *   actions: [{ actionType: "RemoveAllActionGroups" }],
 *   conditions: [
 *     { field: "Severity", operator: "Equals", values: ["Sev3", "Sev4"] },
 *   ],
 *   schedule: {
 *     timeZone: "UTC",
 *     recurrences: [
 *       { recurrenceType: "Weekly", daysOfWeek: ["Saturday", "Sunday"] },
 *     ],
 *   },
 * });
 * ```
 *
 * **Example:** Suppress every alert during a one-off maintenance window
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const rule = yield* Azure.Monitor.AlertProcessingRule("maintenance", {
 *   scopes: [group.resourceGroupId],
 *   actions: [{ actionType: "RemoveAllActionGroups" }],
 *   schedule: {
 *     timeZone: "UTC",
 *     effectiveFrom: "2026-12-24T18:00:00",
 *     effectiveUntil: "2026-12-26T08:00:00",
 *   },
 *   description: "Holiday maintenance",
 * });
 * ```
 *
 * ### Routing Alerts
 * **Example:** Add an action group to every critical alert
 * ```typescript
 * // an action group created outside Alchemy
 * const oncallId =
 *   "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/ops/providers/Microsoft.Insights/actionGroups/oncall";
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const rule = yield* Azure.Monitor.AlertProcessingRule("page-oncall", {
 *   scopes: [group.resourceGroupId],
 *   actions: [{ actionType: "AddActionGroups", actionGroupIds: [oncallId] }],
 *   conditions: [{ field: "Severity", operator: "Equals", values: ["Sev0"] }],
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const AlertProcessingRule = GroupedResource<AlertProcessingRule>(
  "Azure.Monitor.AlertProcessingRule",
);

const LOCATION = "global";

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

/**
 * True when every value set in `desired` is present in `observed`. Strings
 * compare case-insensitively (ARM normalizes casing of IDs and enums);
 * fields the service fills with defaults are ignored when unset.
 */
const subsetOf = (desired: unknown, observed: unknown): boolean => {
  if (desired === undefined) return true;
  if (typeof desired === "string") {
    return typeof observed === "string" && sameText(desired, observed);
  }
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      desired.length === observed.length &&
      desired.every((value, i) => subsetOf(value, observed[i]))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(([key, value]) =>
      subsetOf(value, (observed as Record<string, unknown>)[key]),
    );
  }
  return desired === observed;
};

const createRuleName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 }).pipe(
    Effect.map((name) => name.replace(/[<>*%{}&:\\?+/#|]/g, "-")),
  );

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  alertProcessingRuleName: string,
) =>
  orUndefinedIfNotFound(
    alertsmanagement.GetAlertProcessingRuleByName({
      subscriptionId,
      resourceGroupName,
      alertProcessingRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  rule: alertsmanagement.AlertProcessingRule,
): AlertProcessingRule["Attributes"] => ({
  ruleName: name,
  resourceGroup,
  ruleId: rule.id ?? "",
  scopes: [...(rule.properties?.scopes ?? [])],
  enabled: rule.properties?.enabled ?? true,
  tags: userTags(rule.tags),
});

const toProperties = (
  news: AlertProcessingRuleProps,
): alertsmanagement.AlertProcessingRuleProperties => ({
  scopes: news.scopes,
  actions: news.actions,
  conditions: news.conditions,
  schedule: news.schedule,
  description: news.description,
  enabled: news.enabled ?? true,
});

export const AlertProcessingRuleProvider = () =>
  Provider.succeed(AlertProcessingRule, {
    stables: ["ruleName", "resourceGroup", "ruleId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(alertsmanagement.ListAlertProcessingRuleBySubscription, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((rule) => {
        const group = resourceGroupOf(rule.id);
        return hasAnyAlchemyTag(rule.tags) && group !== undefined && rule.name !== undefined
          ? [toAttrs(group, rule.name, rule)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameText(news.name, output.ruleName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.ruleName ?? olds?.name ?? (yield* createRuleName(id));
      const observed = yield* getRule(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.AlertsManagement");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.ruleName ?? (yield* createRuleName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        alertProcessingRuleName: name,
      };
      const get = getRule(subscriptionId, resourceGroup, name);
      const properties = toProperties(news);

      // Observe.
      const observed = yield* get;

      // Ensure / sync. PUT is a synchronous full-body upsert, so a missing
      // rule or any property delta re-PUTs the desired body; tag-only
      // deltas PATCH just the tags.
      if (
        observed === undefined ||
        !subsetOf(properties, observed.properties) ||
        // An unset optional block must clear what the cloud still holds.
        (news.conditions === undefined && (observed.properties?.conditions?.length ?? 0) > 0) ||
        (news.schedule === undefined && observed.properties?.schedule !== undefined) ||
        (news.description === undefined && observed.properties?.description !== undefined)
      ) {
        yield* alertsmanagement.AlertProcessingRulesCreateOrUpdate({
          ...where,
          location: LOCATION,
          tags,
          properties,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* alertsmanagement.UpdateAlertProcessingRule({ ...where, tags });
      }

      const final = yield* waitForProvisioned(
        `alert processing rule ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, name, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        alertsmanagement.DeleteAlertProcessingRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          alertProcessingRuleName: output.ruleName,
        }),
      );
      yield* waitUntilGone(
        `alert processing rule ${output.ruleName}`,
        getRule(subscriptionId, output.resourceGroup, output.ruleName),
        { interval: "3 seconds", times: 40 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
