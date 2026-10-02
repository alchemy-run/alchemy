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
  hasOwnMarker,
  isWorkspaceOwnedByStack,
  ownershipMarker,
  SENTINEL_NAMESPACE,
  sameText,
  subsetEqual,
  withMarker,
} from "./Common.ts";

/** Kind of analytics rule. */
export type AlertRuleKind =
  | "Scheduled"
  | "Fusion"
  | "MicrosoftSecurityIncidentCreation"
  | (string & {});

export interface AlertRuleProps {
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
  ruleId?: string;
  /**
   * Kind of rule. Changing it replaces the rule.
   * @default "Scheduled"
   */
  kind?: AlertRuleKind;
  /** Display name (required for `Scheduled` and `MicrosoftSecurityIncidentCreation`). */
  displayName?: string;
  /**
   * Description of the rule. An Alchemy ownership marker is appended for
   * kinds that accept a description (all but `Fusion`).
   */
  description?: string;
  /**
   * Whether the rule is enabled.
   * @default true
   */
  enabled?: boolean;
  /** KQL query of a `Scheduled` rule. Tables must exist in the workspace. */
  query?: string;
  /** How often a `Scheduled` rule runs (ISO-8601 duration, e.g. `PT1H`). */
  queryFrequency?: string;
  /** Time window a `Scheduled` rule queries (ISO-8601 duration, e.g. `PT1H`). */
  queryPeriod?: string;
  /** Severity of alerts: `High`, `Medium`, `Low`, or `Informational`. */
  severity?: "High" | "Medium" | "Low" | "Informational" | (string & {});
  /**
   * Operator comparing the result count to `triggerThreshold` (`Scheduled`).
   * @default "GreaterThan"
   */
  triggerOperator?:
    | "GreaterThan"
    | "LessThan"
    | "Equal"
    | "NotEqual"
    | (string & {});
  /**
   * Result-count threshold that raises an alert (`Scheduled`).
   * @default 0
   */
  triggerThreshold?: number;
  /**
   * Whether alert suppression is enabled (`Scheduled`).
   * @default false
   */
  suppressionEnabled?: boolean;
  /**
   * Suppression window (ISO-8601 duration, `Scheduled`).
   * @default "PT5H"
   */
  suppressionDuration?: string;
  /** MITRE ATT&CK tactics, e.g. `["InitialAccess"]`. */
  tactics?: string[];
  /** MITRE ATT&CK techniques, e.g. `["T1078"]`. */
  techniques?: string[];
  /** Name of the rule template the rule was created from. Changing it replaces the rule. */
  alertRuleTemplateName?: string;
  /** Version of the rule template. */
  templateVersion?: string;
  /** Incident creation and grouping settings (`Scheduled`). */
  incidentConfiguration?: Record<string, unknown>;
  /** Event grouping settings, e.g. `{ aggregationKind: "SingleAlert" }`. */
  eventGroupingSettings?: Record<string, unknown>;
  /** Custom details surfaced on alerts (column name by key). */
  customDetails?: Record<string, string>;
  /** Entity mappings of query columns to entity identifiers. */
  entityMappings?: Record<string, unknown>[];
  /** Overrides of alert display name/description/severity from query columns. */
  alertDetailsOverride?: Record<string, unknown>;
  /** Product filter of a `MicrosoftSecurityIncidentCreation` rule, e.g. `Microsoft Cloud App Security`. */
  productFilter?: string;
  /** Severities filter of a `MicrosoftSecurityIncidentCreation` rule. */
  severitiesFilter?: string[];
  /** Alert names that must be included (`MicrosoftSecurityIncidentCreation`). */
  displayNamesFilter?: string[];
  /** Alert names that must be excluded (`MicrosoftSecurityIncidentCreation`). */
  displayNamesExcludeFilter?: string[];
}

export interface AlertRule extends Resource<
  "Azure.SecurityInsights.AlertRule",
  AlertRuleProps,
  {
    /** Rule ID (GUID). */
    ruleId: string;
    /** ARM resource ID of the rule. */
    alertRuleResourceId: string;
    /** Kind of the rule. */
    kind: string;
    /** Sentinel workspace of the rule. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** Display name of the rule. */
    displayName: string | undefined;
    /** Whether the rule is enabled. */
    enabled: boolean | undefined;
    /** Last modification time (UTC). */
    lastModifiedUtc: string | undefined;
    /** ETag of the rule. */
    etag: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Sentinel analytics rule: a scheduled or near-real-time KQL
 * query that raises alerts and incidents, the Fusion correlation engine, or
 * a rule creating incidents from Microsoft security product alerts.
 * (Near-real-time `NRT` rules are not supported by the API version the
 * SDK targets.)
 *
 * @see https://learn.microsoft.com/azure/sentinel/create-analytics-rules
 *
 * ### Scheduled Query Rules
 * **Example:** Alert on failed heartbeats
 * ```typescript
 * const sentinel = yield* Azure.SecurityInsights.OnboardingState("sentinel", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 * });
 * const rule = yield* Azure.SecurityInsights.AlertRule("heartbeat", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   displayName: "Missing heartbeat",
 *   severity: "Medium",
 *   query: "Heartbeat | summarize LastSeen = max(TimeGenerated) by Computer",
 *   queryFrequency: "PT1H",
 *   queryPeriod: "PT1H",
 *   tactics: ["Impact"],
 * });
 * ```
 *
 * ### Product Alert Incidents
 * **Example:** Create incidents from Defender for Cloud alerts
 * ```typescript
 * yield* Azure.SecurityInsights.AlertRule("defender-incidents", {
 *   resourceGroup: sentinel.resourceGroup,
 *   workspace: sentinel.workspace,
 *   kind: "MicrosoftSecurityIncidentCreation",
 *   displayName: "Defender for Cloud incidents",
 *   productFilter: "Azure Security Center",
 *   severitiesFilter: ["High", "Medium"],
 * });
 * ```
 *
 * @resource
 */
export const AlertRule = Resource<AlertRule>("Azure.SecurityInsights.AlertRule");

type RuleProperties = Record<string, unknown> & {
  displayName?: string;
  description?: string;
  enabled?: boolean;
  lastModifiedUtc?: string;
};

const ruleProperties = (
  rule: securityinsights.GetAlertRuleResponse | undefined,
): RuleProperties => (rule?.properties ?? {}) as RuleProperties;

const supportsDescription = (kind: string) => !sameText(kind, "Fusion");

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  ruleId: string,
) =>
  orUndefinedIfNotFound(
    securityinsights.GetAlertRule({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      ruleId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  ruleId: string,
  rule: securityinsights.GetAlertRuleResponse,
): AlertRule["Attributes"] => {
  const props = ruleProperties(rule);
  return {
    ruleId,
    alertRuleResourceId: rule.id ?? "",
    kind: rule.kind,
    workspace,
    resourceGroup,
    displayName: props.displayName,
    enabled: props.enabled,
    lastModifiedUtc: props.lastModifiedUtc,
    etag: rule.etag,
  };
};

const desiredProperties = (
  news: AlertRuleProps,
  kind: string,
  marker: string,
): Record<string, unknown> => {
  const scheduled = sameText(kind, "Scheduled");
  return compact({
    displayName: news.displayName,
    description: supportsDescription(kind)
      ? withMarker(news.description, marker)
      : undefined,
    enabled: news.enabled ?? true,
    query: news.query,
    queryFrequency: news.queryFrequency,
    queryPeriod: news.queryPeriod,
    severity: news.severity,
    triggerOperator: scheduled
      ? (news.triggerOperator ?? "GreaterThan")
      : news.triggerOperator,
    triggerThreshold: scheduled
      ? (news.triggerThreshold ?? 0)
      : news.triggerThreshold,
    suppressionEnabled: scheduled
      ? (news.suppressionEnabled ?? false)
      : news.suppressionEnabled,
    suppressionDuration: scheduled
      ? (news.suppressionDuration ?? "PT5H")
      : news.suppressionDuration,
    tactics: news.tactics,
    techniques: news.techniques,
    alertRuleTemplateName: news.alertRuleTemplateName,
    templateVersion: news.templateVersion,
    incidentConfiguration: news.incidentConfiguration,
    eventGroupingSettings: news.eventGroupingSettings,
    customDetails: news.customDetails,
    entityMappings: news.entityMappings,
    alertDetailsOverride: news.alertDetailsOverride,
    productFilter: news.productFilter,
    severitiesFilter: news.severitiesFilter,
    displayNamesFilter: news.displayNamesFilter,
    displayNamesExcludeFilter: news.displayNamesExcludeFilter,
  });
};

export const AlertRuleProvider = () =>
  Provider.succeed(AlertRule, {
    stables: ["ruleId", "alertRuleResourceId", "kind", "workspace", "resourceGroup"],

    // Rules live inside the workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        !sameText(news.kind ?? "Scheduled", output.kind) ||
        (news.ruleId !== undefined && !sameText(news.ruleId, output.ruleId)) ||
        (olds !== undefined &&
          (news.alertRuleTemplateName ?? "") !==
            (olds.alertRuleTemplateName ?? ""))
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
        output?.ruleId ??
        olds?.ruleId ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        workspace,
        ruleId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, ruleId, observed);
      const owned =
        (yield* isWorkspaceOwnedByStack(
          subscriptionId,
          resourceGroup,
          workspace,
        )) &&
        (!supportsDescription(observed.kind) ||
          (yield* hasOwnMarker(id, ruleProperties(observed).description)));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SENTINEL_NAMESPACE);
      const { resourceGroup, workspace } = news;
      const kind = news.kind ?? "Scheduled";
      const ruleId =
        news.ruleId ??
        output?.ruleId ??
        (yield* deterministicGuid(id, instanceId));
      const marker = yield* ownershipMarker(id);
      const desired = desiredProperties(news, kind, marker);

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
        !subsetEqual(desired, ruleProperties(observed))
      ) {
        observed = yield* securityinsights.AlertRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workspaceName: workspace,
          ruleId,
          kind: kind as securityinsights.AlertRuleKind,
          etag: observed?.etag,
          properties: desired,
        });
      }
      return toAttrs(resourceGroup, workspace, ruleId, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        securityinsights.DeleteAlertRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          ruleId: output.ruleId,
        }),
      );
      yield* waitUntilGone(
        `alert rule ${output.ruleId}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.ruleId,
        ),
      );
    }),
  });
