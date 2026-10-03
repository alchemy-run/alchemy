import * as alertsmanagement from "@distilled.cloud/azure/alertsmanagement";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export type SmartDetectorSeverity = "Sev0" | "Sev1" | "Sev2" | "Sev3" | "Sev4";

export interface SmartDetectorAlertRuleProps {
  /**
   * Resource group the rule is created in. Changing it replaces the rule.
   */
  resourceGroup: string;
  /**
   * Rule name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /**
   * Smart detector to run, e.g. `FailureAnomaliesDetector`,
   * `RequestPerformanceDegradationDetector`,
   * `DependencyPerformanceDegradationDetector`, `TraceSeverityDetector`,
   * `MemoryLeakDetector`. Changing the detector id replaces the rule.
   */
  detector: {
    /** Detector id. */
    id: string;
    /** Detector-specific parameters. */
    parameters?: Record<string, unknown>;
  };
  /** ARM IDs of the resources (Application Insights components) to watch. */
  scopes: string[];
  /** Alert severity. */
  severity: SmartDetectorSeverity;
  /**
   * How often the detector runs, ISO 8601 duration in whole minutes (e.g.
   * `PT1M`); the minimum depends on the detector.
   */
  frequency: string;
  /** Action groups notified when the detector fires. */
  actionGroups: {
    /** ARM resource IDs of the action groups. */
    groupIds: string[];
    /** Custom subject for email notifications. */
    customEmailSubject?: string;
    /** Custom JSON payload for webhook notifications. */
    customWebhookPayload?: string;
  };
  /**
   * Whether the rule is evaluated.
   * @default "Enabled"
   */
  state?: "Enabled" | "Disabled";
  /** Wait this ISO 8601 duration before notifying on the rule again. */
  throttling?: {
    /** Throttling duration in whole minutes, e.g. `PT30M`. */
    duration?: string;
  };
  /** Description of the rule. */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SmartDetectorAlertRule extends Resource<
  "Azure.Monitor.SmartDetectorAlertRule",
  SmartDetectorAlertRuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** Resource group that holds the rule. */
    resourceGroup: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Detector id. */
    detectorId: string;
    /** Scopes the detector watches. */
    scopes: string[];
    /** Rule state. */
    state: string;
    /** Alert severity. */
    severity: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor smart detector alert rule — runs an Application Insights
 * smart detector (failure anomalies, performance degradation, memory leaks,
 * …) and notifies action groups when it finds an anomaly. Rules are global
 * resources.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/alerts/proactive-failure-diagnostics
 *
 * ### Failure Anomalies
 * **Example:** Notify an action group about failure anomalies of an app
 * ```typescript
 * const rule = yield* Azure.Monitor.SmartDetectorAlertRule("failures", {
 *   resourceGroup: group.resourceGroupName,
 *   detector: { id: "FailureAnomaliesDetector" },
 *   scopes: [appInsightsId],
 *   severity: "Sev3",
 *   frequency: "PT1M",
 *   actionGroups: { groupIds: [actionGroupId] },
 * });
 * ```
 *
 * ### Tuning Notifications
 * **Example:** Throttle notifications and customize the email subject
 * ```typescript
 * const rule = yield* Azure.Monitor.SmartDetectorAlertRule("failures", {
 *   resourceGroup: group.resourceGroupName,
 *   detector: { id: "FailureAnomaliesDetector" },
 *   scopes: [appInsightsId],
 *   severity: "Sev2",
 *   frequency: "PT5M",
 *   throttling: { duration: "PT60M" },
 *   actionGroups: {
 *     groupIds: [actionGroupId],
 *     customEmailSubject: "Failure anomaly detected",
 *   },
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const SmartDetectorAlertRule = Resource<SmartDetectorAlertRule>(
  "Azure.Monitor.SmartDetectorAlertRule",
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
  alertRuleName: string,
) =>
  orUndefinedIfNotFound(
    alertsmanagement.GetSmartDetectorAlertRule({
      subscriptionId,
      resourceGroupName,
      alertRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  rule: alertsmanagement.AlertRule,
): SmartDetectorAlertRule["Attributes"] => ({
  ruleName: name,
  resourceGroup,
  ruleId: rule.id ?? "",
  detectorId: rule.properties?.detector.id ?? "",
  scopes: [...(rule.properties?.scope ?? [])],
  state: rule.properties?.state ?? "Enabled",
  severity: rule.properties?.severity ?? "",
  tags: userTags(rule.tags),
});

const toProperties = (
  news: SmartDetectorAlertRuleProps,
): alertsmanagement.AlertRulePropertiesInput => ({
  description: news.description,
  state: news.state ?? "Enabled",
  severity: news.severity,
  frequency: news.frequency,
  detector: news.detector,
  scope: news.scopes,
  actionGroups: news.actionGroups,
  throttling: news.throttling,
});

export const SmartDetectorAlertRuleProvider = () =>
  Provider.succeed(SmartDetectorAlertRule, {
    stables: ["ruleName", "resourceGroup", "ruleId", "detectorId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* alertsmanagement
        .ListSmartDetectorAlertRules({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSmartDetectorAlertRules", page),
          ),
        );
      return (page.value ?? []).flatMap((rule) => {
        const group = resourceGroupOf(rule.id);
        return hasAnyAlchemyTag(rule.tags) &&
          group !== undefined &&
          rule.name !== undefined
          ? [toAttrs(group, rule.name, rule)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameText(news.name, output.ruleName)) ||
        !sameText(news.detector.id, output.detectorId)
      ) {
        // Azure allows one rule per detector and scope resource, so the old
        // rule must be gone before its replacement is created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.ruleName ?? olds?.name ?? (yield* createRuleName(id));
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
        alertRuleName: name,
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
        (news.description === undefined &&
          (observed.properties?.description ?? "") !== "") ||
        (news.throttling === undefined &&
          observed.properties?.throttling?.duration !== undefined)
      ) {
        yield* alertsmanagement.SmartDetectorAlertRulesCreateOrUpdate({
          ...where,
          location: LOCATION,
          tags,
          properties,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* alertsmanagement.PatchSmartDetectorAlertRule({ ...where, tags });
      }

      const final = yield* waitForProvisioned(
        `smart detector alert rule ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, name, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        alertsmanagement.DeleteSmartDetectorAlertRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          alertRuleName: output.ruleName,
        }),
      );
      yield* waitUntilGone(
        `smart detector alert rule ${output.ruleName}`,
        getRule(subscriptionId, output.resourceGroup, output.ruleName),
        { interval: "3 seconds", times: 40 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
