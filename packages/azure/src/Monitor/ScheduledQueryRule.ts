import * as monitor from "@distilled.cloud/azure/monitor";
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

export type ScheduledQueryRuleKind = "LogAlert" | "SimpleLogAlert" | "LogToMetric";

export interface ScheduledQueryRuleIdentity {
  /** Kind of managed identity attached to the rule. */
  type: "SystemAssigned" | "UserAssigned" | "None";
  /**
   * ARM resource IDs of user-assigned identities. Required when `type` is
   * `UserAssigned`.
   * @default []
   */
  userAssignedIdentities?: string[];
}

export interface ScheduledQueryRuleDimension {
  /** Name of the dimension (a column of the query result). */
  name: string;
  /** Whether `values` are included or excluded. */
  operator: "Include" | "Exclude";
  /** Dimension values; `["*"]` splits by every value. */
  values: string[];
}

export interface ScheduledQueryRuleCondition {
  /**
   * Threshold criteria type.
   * @default "StaticThresholdCriterion"
   */
  criterionType?: "StaticThresholdCriterion" | "DynamicThresholdCriterion";
  /**
   * KQL log query evaluated against the rule's scopes.
   * @default none (required for `LogAlert` and `SimpleLogAlert`)
   */
  query?: string;
  /**
   * Aggregation applied to the query result. Required for `LogAlert`.
   * @default none
   */
  timeAggregation?: "Count" | "Average" | "Minimum" | "Maximum" | "Total";
  /**
   * Column holding the measured number (non-`Count` aggregations).
   * @default none (counts rows)
   */
  metricMeasureColumn?: string;
  /**
   * Column holding the ARM resource ID the alert fires for.
   * @default none
   */
  resourceIdColumn?: string;
  /**
   * Dimension splitting and filtering.
   * @default [] (one alert for the whole result)
   */
  dimensions?: ScheduledQueryRuleDimension[];
  /**
   * Comparison operator. Required for `LogAlert`.
   * @default none
   */
  operator?:
    | "Equals"
    | "GreaterThan"
    | "GreaterThanOrEqual"
    | "LessThan"
    | "LessThanOrEqual"
    | "GreaterOrLessThan";
  /**
   * Static threshold that fires the alert (`StaticThresholdCriterion`).
   * @default none
   */
  threshold?: number;
  /**
   * Dynamic threshold sensitivity: `Low`, `Medium` or `High`
   * (`DynamicThresholdCriterion`).
   * @default Azure's default
   */
  alertSensitivity?: string;
  /**
   * ISO 8601 date before which dynamic thresholds ignore history.
   * @default all history is used
   */
  ignoreDataBefore?: string;
  /**
   * Number of violating evaluation periods required to fire.
   * @default one failing period out of one
   */
  failingPeriods?: {
    /** Number of aggregated lookback points. @default 1 */
    numberOfEvaluationPeriods?: number;
    /** Violations needed to fire (≤ `numberOfEvaluationPeriods`). @default 1 */
    minFailingPeriodsToAlert?: number;
  };
  /**
   * Metric name to emit. Required for `LogToMetric`.
   * @default none
   */
  metricName?: string;
  /**
   * Minimum result count that fires a `SimpleLogAlert`.
   * @default Azure's default
   */
  minRecurrenceCount?: number;
}

export interface ScheduledQueryRuleProps {
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
   * Rule name (at most 64 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the rule; must match the region of the scoped
   * resources.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Rule kind: `LogAlert` (aggregated query with a threshold),
   * `SimpleLogAlert` (fires on matching results), or `LogToMetric` (emits
   * a metric).
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default "LogAlert"
   */
  kind?: ScheduledQueryRuleKind;
  /**
   * ARM resource IDs the query runs against (Log Analytics workspaces,
   * Application Insights components, or other resources).
   *
   * :::caution
   * Changing them replaces the rule.
   * :::
   */
  scopes: string[];
  /** Conditions evaluated on every run (`criteria.allOf`); all must hold. */
  criteria: ScheduledQueryRuleCondition[];
  /**
   * Display name of the alert rule.
   * @default none
   */
  displayName?: string;
  /**
   * Description of the alert rule.
   * @default none
   */
  description?: string;
  /**
   * Alert severity, 0 (critical) to 4 (verbose). Required for `LogAlert`.
   * @default none
   */
  severity?: 0 | 1 | 2 | 3 | 4;
  /**
   * Whether the rule is evaluated.
   * @default true
   */
  enabled?: boolean;
  /**
   * How often the rule runs, ISO 8601 duration (e.g. `PT5M`). Required for
   * `LogAlert`.
   * @default none
   */
  evaluationFrequency?: string;
  /**
   * Query time window (bin size), ISO 8601 duration (e.g. `PT15M`).
   * Required for `LogAlert`.
   * @default none
   */
  windowSize?: string;
  /**
   * Overrides the query time range, ISO 8601 duration.
   * @default `windowSize`
   */
  overrideQueryTimeRange?: string;
  /**
   * Resource types an alert is split by when the scope is a resource
   * group or subscription.
   * @default []
   */
  targetResourceTypes?: string[];
  /**
   * Mute actions for this ISO 8601 duration after the alert fires.
   * @default no muting
   */
  muteActionsDuration?: string;
  /**
   * Actions invoked when the alert fires.
   * @default no actions (the alert only appears in Azure Monitor)
   */
  actions?: {
    /** Action group ARM resource IDs. @default [] */
    actionGroups?: string[];
    /** Custom properties added to the alert payload. @default {} */
    customProperties?: Record<string, string>;
    /** Action properties. @default {} */
    actionProperties?: Record<string, string>;
  };
  /**
   * Store the rule in the workspace's customer-managed storage.
   * @default Azure's default (`false`)
   */
  checkWorkspaceAlertsStorageConfigured?: boolean;
  /**
   * Skip validating the query on write (useful when the queried tables do
   * not exist yet). Write-only; not compared against observed state.
   * @default false
   */
  skipQueryValidation?: boolean;
  /**
   * Automatically resolve fired alerts. Unset leaves the service default.
   * @default Azure's default
   */
  autoMitigate?: boolean;
  /**
   * How fired alerts are resolved.
   * @default Azure's default
   */
  resolveConfiguration?: {
    /** Whether fired alerts are resolved automatically. @default Azure's default */
    autoResolved?: boolean;
    /** Healthy duration (ISO 8601) before an alert is resolved. @default Azure's default */
    timeToResolve?: string;
  };
  /**
   * Managed identity used to run the query. Unset leaves identity unmanaged.
   * @default the observed identity is kept (none on a new rule)
   */
  identity?: ScheduledQueryRuleIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface ScheduledQueryRule extends Resource<
  "Azure.Monitor.ScheduledQueryRule",
  ScheduledQueryRuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** Resource group that holds the rule. */
    resourceGroup: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Location of the rule. */
    location: string;
    /** Rule kind. */
    kind: string;
    /** Scopes the rule queries. */
    scopes: string[];
    /** Whether the rule is enabled. */
    enabled: boolean | undefined;
    /** Alert severity. */
    severity: number | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Whether the rule is stored in customer-managed workspace storage. */
    isWorkspaceAlertsStorageConfigured: boolean | undefined;
    /** API version the rule was created with. */
    createdWithApiVersion: string | undefined;
    /** Whether the rule is a legacy Log Analytics alert. */
    isLegacyLogAnalyticsRule: boolean | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor scheduled query rule, or log search alert
 * (`Microsoft.Insights/scheduledQueryRules`): it runs a KQL query against a
 * Log Analytics workspace, an Application Insights component, or another
 * resource on a schedule, and fires an alert (or emits a metric) when its
 * conditions hold.
 *
 * Alchemy creates an enabled `LogAlert` rule in the stack's resource group.
 * The rule runs in the region of the resources it queries, so set
 * `location` to their region when it differs from the stack's default.
 *
 * :::caution[Changing `name`, `resourceGroup`, `location`, `kind`, or `scopes` replaces the rule]
 * Alchemy creates a new rule and deletes the old one.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-types#log-alerts
 *
 * ### Creating a Log Alert
 * **Example:** Alert when a workspace receives no heartbeats
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const noHeartbeat = yield* Azure.Monitor.ScheduledQueryRule("no-heartbeat", {
 *   scopes: [logs.workspaceId],
 *   severity: 2,
 *   evaluationFrequency: "PT5M",
 *   windowSize: "PT15M",
 *   criteria: [
 *     {
 *       query: "Heartbeat",
 *       timeAggregation: "Count",
 *       operator: "LessThan",
 *       threshold: 1,
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Alert on a custom table that does not exist yet
 * ```typescript
 * const errors = yield* Azure.Monitor.ScheduledQueryRule("app-errors", {
 *   scopes: [logs.workspaceId],
 *   severity: 1,
 *   evaluationFrequency: "PT5M",
 *   windowSize: "PT5M",
 *   skipQueryValidation: true,
 *   criteria: [
 *     {
 *       query: "AppEvents_CL | where Level == 'error'",
 *       timeAggregation: "Count",
 *       operator: "GreaterThan",
 *       threshold: 10,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Measuring a Column
 * **Example:** Average request duration above 2 seconds
 * ```typescript
 * const slow = yield* Azure.Monitor.ScheduledQueryRule("slow-requests", {
 *   scopes: [logs.workspaceId],
 *   severity: 3,
 *   evaluationFrequency: "PT5M",
 *   windowSize: "PT15M",
 *   criteria: [
 *     {
 *       query: "AppRequests | project TimeGenerated, DurationMs",
 *       timeAggregation: "Average",
 *       metricMeasureColumn: "DurationMs",
 *       operator: "GreaterThan",
 *       threshold: 2000,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Splitting and Noise Control
 * **Example:** One alert per computer, three bad periods out of four
 * ```typescript
 * const errorsPerHost = yield* Azure.Monitor.ScheduledQueryRule("errors-per-host", {
 *   scopes: [logs.workspaceId],
 *   severity: 2,
 *   evaluationFrequency: "PT5M",
 *   windowSize: "PT5M",
 *   muteActionsDuration: "PT1H",
 *   criteria: [
 *     {
 *       query: "Event | where EventLevelName == 'Error'",
 *       timeAggregation: "Count",
 *       operator: "GreaterThan",
 *       threshold: 10,
 *       dimensions: [{ name: "Computer", operator: "Include", values: ["*"] }],
 *       failingPeriods: { numberOfEvaluationPeriods: 4, minFailingPeriodsToAlert: 3 },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Routing Alerts
 * **Example:** Notify an action group with extra payload fields
 * ```typescript
 * // an action group created outside Alchemy
 * const oncallId =
 *   "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/ops/providers/Microsoft.Insights/actionGroups/oncall";
 * const errors = yield* Azure.Monitor.ScheduledQueryRule("errors", {
 *   scopes: [logs.workspaceId],
 *   severity: 1,
 *   evaluationFrequency: "PT5M",
 *   windowSize: "PT5M",
 *   criteria: [
 *     {
 *       query: "AppEvents_CL | where Level == 'error'",
 *       timeAggregation: "Count",
 *       operator: "GreaterThan",
 *       threshold: 10,
 *     },
 *   ],
 *   actions: {
 *     actionGroups: [oncallId],
 *     customProperties: { team: "platform", runbook: "https://example.com/runbooks/errors" },
 *   },
 * });
 * ```
 *
 * ### Pausing a Rule
 * **Example:** Keep the rule but stop evaluating it
 * ```typescript
 * const noHeartbeat = yield* Azure.Monitor.ScheduledQueryRule("no-heartbeat", {
 *   scopes: [logs.workspaceId],
 *   enabled: false,
 *   severity: 2,
 *   evaluationFrequency: "PT5M",
 *   windowSize: "PT15M",
 *   criteria: [
 *     { query: "Heartbeat", timeAggregation: "Count", operator: "LessThan", threshold: 1 },
 *   ],
 * });
 * ```
 *
 * ### Querying with a Managed Identity
 * **Example:** Run the query as the rule's system-assigned identity
 * ```typescript
 * const rule = yield* Azure.Monitor.ScheduledQueryRule("errors", {
 *   scopes: [logs.workspaceId],
 *   identity: { type: "SystemAssigned" },
 *   severity: 2,
 *   evaluationFrequency: "PT5M",
 *   windowSize: "PT5M",
 *   criteria: [
 *     {
 *       query: "AppEvents_CL | where Level == 'error'",
 *       timeAggregation: "Count",
 *       operator: "GreaterThan",
 *       threshold: 0,
 *     },
 *   ],
 * });
 * // grant rule.principalId Log Analytics Reader on the workspace
 * ```
 *
 * @resource
 */
export const ScheduledQueryRule = GroupedResource<ScheduledQueryRule>(
  "Azure.Monitor.ScheduledQueryRule",
);

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const sameLocation = (a: string, b: string) =>
  sameText(a.replaceAll(" ", ""), b.replaceAll(" ", ""));

const sameScopes = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify(a.map((s) => s.toLowerCase()).sort()) ===
  JSON.stringify(b.map((s) => s.toLowerCase()).sort());

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

const getRule = (subscriptionId: string, resourceGroupName: string, ruleName: string) =>
  orUndefinedIfNotFound(
    monitor.GetScheduledQueryRule({
      subscriptionId,
      resourceGroupName,
      ruleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  rule: monitor.ScheduledQueryRuleResource,
): ScheduledQueryRule["Attributes"] => ({
  ruleName: name,
  resourceGroup,
  ruleId: rule.id ?? "",
  location: rule.location,
  kind: rule.kind ?? "LogAlert",
  scopes: [...(rule.properties?.scopes ?? [])],
  enabled: rule.properties?.enabled,
  severity: rule.properties?.severity,
  principalId: rule.identity?.principalId,
  isWorkspaceAlertsStorageConfigured: rule.properties?.isWorkspaceAlertsStorageConfigured,
  createdWithApiVersion: rule.properties?.createdWithApiVersion,
  isLegacyLogAnalyticsRule: rule.properties?.isLegacyLogAnalyticsRule,
  tags: userTags(rule.tags),
});

const toIdentityInput = (identity: ScheduledQueryRuleIdentity): monitor.IdentityInput => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities
    ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
    : undefined,
});

const identityDiffers = (
  observed: monitor.Identity | undefined,
  desired: ScheduledQueryRuleIdentity,
) => {
  if (!sameText(observed?.type ?? "None", desired.type)) return true;
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const want = (desired.userAssignedIdentities ?? []).map((id) => id.toLowerCase()).sort();
  return JSON.stringify(have) !== JSON.stringify(want);
};

const toProperties = (
  news: ScheduledQueryRuleProps,
): monitor.ScheduledQueryRulePropertiesInput => ({
  displayName: news.displayName,
  description: news.description,
  severity: news.severity,
  enabled: news.enabled ?? true,
  scopes: news.scopes,
  evaluationFrequency: news.evaluationFrequency,
  windowSize: news.windowSize,
  overrideQueryTimeRange: news.overrideQueryTimeRange,
  targetResourceTypes: news.targetResourceTypes,
  criteria: { allOf: news.criteria },
  muteActionsDuration: news.muteActionsDuration,
  actions: news.actions,
  checkWorkspaceAlertsStorageConfigured: news.checkWorkspaceAlertsStorageConfigured,
  skipQueryValidation: news.skipQueryValidation,
  autoMitigate: news.autoMitigate,
  resolveConfiguration: news.resolveConfiguration,
});

/** Whether the observed rule properties differ from the desired ones. */
const propertiesDiffer = (
  observed: monitor.ScheduledQueryRuleProperties | undefined,
  desired: monitor.ScheduledQueryRulePropertiesInput,
) => {
  const { skipQueryValidation: _writeOnly, ...compared } = desired;
  return !subsetOf(compared, observed);
};

export const ScheduledQueryRuleProvider = () =>
  Provider.succeed(ScheduledQueryRule, {
    stables: ["ruleName", "resourceGroup", "ruleId", "location", "kind"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(monitor.ListScheduledQueryRuleBySubscription, {
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
        (news.name !== undefined && !sameText(news.name, output.ruleName)) ||
        (news.location !== undefined && !sameLocation(news.location, output.location)) ||
        !sameText(news.kind ?? "LogAlert", output.kind) ||
        !sameScopes(news.scopes, output.scopes)
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
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Insights");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.ruleName ?? (yield* createRuleName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        ruleName: name,
      };
      const get = getRule(subscriptionId, resourceGroup, name);
      const properties = toProperties(news);

      // Observe.
      const observed = yield* get;

      // Ensure / sync. PUT is a full-body upsert, so a missing rule or any
      // property/identity delta re-PUTs the desired body; tag-only deltas
      // PATCH just the tags.
      const identityDelta =
        news.identity !== undefined && identityDiffers(observed?.identity, news.identity);
      if (
        observed === undefined ||
        identityDelta ||
        propertiesDiffer(observed.properties, properties)
      ) {
        yield* monitor.ScheduledQueryRulesCreateOrUpdate({
          ...where,
          location: observed?.location ?? news.location ?? env.location,
          kind: news.kind ?? "LogAlert",
          tags,
          identity: news.identity
            ? toIdentityInput(news.identity)
            : observed?.identity
              ? {
                  type: observed.identity.type,
                  userAssignedIdentities: observed.identity.userAssignedIdentities
                    ? Object.fromEntries(
                        Object.keys(observed.identity.userAssignedIdentities).map((uai) => [
                          uai,
                          {},
                        ]),
                      )
                    : undefined,
                }
              : undefined,
          properties,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* monitor.UpdateScheduledQueryRule({ ...where, tags });
      }

      // The PUT is synchronous; re-read to return fresh attributes.
      const final = yield* waitForProvisioned(
        `scheduled query rule ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, name, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        monitor.DeleteScheduledQueryRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          ruleName: output.ruleName,
        }),
      );
      yield* waitUntilGone(
        `scheduled query rule ${output.ruleName}`,
        getRule(subscriptionId, output.resourceGroup, output.ruleName),
        { interval: "3 seconds", times: 40 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
