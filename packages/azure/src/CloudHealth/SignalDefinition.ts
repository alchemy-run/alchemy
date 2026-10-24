import * as cloudhealth from "@distilled.cloud/azure/cloudhealth";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createChildName, isSubset, NAMESPACE, sameName, whileBusy } from "./internal.ts";

/** Data source a signal evaluates. */
export type SignalKind = "AzureResourceMetric" | "LogAnalyticsQuery" | "PrometheusMetricsQuery";
/** How often the signal is evaluated. */
export type SignalRefreshInterval = "PT1M" | "PT5M" | "PT10M" | "PT15M" | "PT30M" | "PT1H" | "PT2H";
/** Aggregation applied to an Azure Monitor metric. */
export type SignalMetricAggregation =
  | "None"
  | "Average"
  | "Count"
  | "Minimum"
  | "Maximum"
  | "Total";
/** Thresholds that turn the signal degraded or unhealthy. */
export type SignalEvaluationRules = cloudhealth.EvaluationRule;

export interface SignalDefinitionProps {
  /** Resource group of the health model. Changing it replaces the definition. */
  resourceGroup: string;
  /** Health model that holds the definition. Changing it replaces the definition. */
  healthModel: string;
  /**
   * Definition name: 3-260 letters, digits, and hyphens, starting and
   * ending with a letter or digit. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the
   * definition.
   */
  name?: string;
  /** Display name. */
  displayName?: string;
  /**
   * Data source of the signal. Changing it replaces the definition.
   * - `AzureResourceMetric`: set `metricNamespace`, `metricName`,
   *   `aggregationType`, and `timeGrain`.
   * - `LogAnalyticsQuery`: set `queryText` (KQL), optionally `timeGrain`
   *   and `valueColumnName`.
   * - `PrometheusMetricsQuery`: set `queryText` (PromQL), optionally
   *   `timeGrain`.
   */
  signalKind: SignalKind;
  /** Metric namespace, e.g. `microsoft.storage/storageaccounts` (`AzureResourceMetric`). */
  metricNamespace?: string;
  /** Metric name, e.g. `Availability` (`AzureResourceMetric`). */
  metricName?: string;
  /** Aggregation applied to the metric (`AzureResourceMetric`). */
  aggregationType?: SignalMetricAggregation;
  /** Dimension filter applied to the metric (`AzureResourceMetric`). */
  dimensionFilter?: string;
  /** Query text: KQL for `LogAnalyticsQuery`, PromQL for `PrometheusMetricsQuery`. */
  queryText?: string;
  /**
   * Numeric result column evaluated against the thresholds
   * (`LogAnalyticsQuery`).
   * @default the first column
   */
  valueColumnName?: string;
  /** Time range of the signal as an ISO 8601 duration, e.g. `PT5M`. */
  timeGrain?: string;
  /**
   * How often the signal is evaluated.
   * @default "PT1M"
   */
  refreshInterval?: SignalRefreshInterval;
  /** Unit of the signal value, e.g. `Percent`, `Count`, `MilliSeconds`. */
  dataUnit?: string;
  /** Thresholds that turn the signal degraded or unhealthy. */
  evaluationRules: SignalEvaluationRules;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SignalDefinition extends Resource<
  "Azure.CloudHealth.SignalDefinition",
  SignalDefinitionProps,
  {
    /** Name of the signal definition; reference it from an entity signal's `signalDefinitionName`. */
    signalDefinitionName: string;
    /** ARM resource ID of the signal definition. */
    signalDefinitionId: string;
    /** Health model that holds the definition. */
    healthModelName: string;
    /** Resource group of the health model. */
    resourceGroup: string;
    /** Display name. */
    displayName: string | undefined;
    /** Data source of the signal. */
    signalKind: string;
    /** Evaluation interval. */
    refreshInterval: string | undefined;
    /** Provisioning state reported by Azure, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A signal definition of an Azure Monitor health model
 * (`Microsoft.CloudHealth/healthmodels/signaldefinitions`): a reusable
 * signal (an Azure Monitor metric, a Log Analytics query, or a Prometheus
 * query) with its health thresholds. Entity signals reference it by name
 * to share the query and thresholds.
 *
 * Alchemy records ownership in the definition's own tags.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/health-models/overview
 *
 * ### Creating a Signal Definition
 * **Example:** Storage availability metric
 * ```typescript
 * const model = yield* Azure.CloudHealth.HealthModel("shop-health", {
 *   location: "westeurope",
 * });
 * const availability = yield* Azure.CloudHealth.SignalDefinition("availability", {
 *   healthModel: model.healthModelName,
 *   displayName: "Availability",
 *   signalKind: "AzureResourceMetric",
 *   metricNamespace: "microsoft.storage/storageaccounts",
 *   metricName: "Availability",
 *   aggregationType: "Average",
 *   timeGrain: "PT5M",
 *   dataUnit: "Percent",
 *   evaluationRules: {
 *     degradedRule: { operator: "LessThan", threshold: 99.9 },
 *     unhealthyRule: { operator: "LessThan", threshold: 99 },
 *   },
 * });
 * ```
 *
 * **Example:** Log Analytics query
 * ```typescript
 * const errors = yield* Azure.CloudHealth.SignalDefinition("errors", {
 *   healthModel: model.healthModelName,
 *   signalKind: "LogAnalyticsQuery",
 *   queryText: "AppRequests | where Success == false | count",
 *   timeGrain: "PT15M",
 *   refreshInterval: "PT5M",
 *   evaluationRules: {
 *     unhealthyRule: { operator: "GreaterThan", threshold: 10 },
 *   },
 * });
 * ```
 *
 * :::caution
 * Changing `name`, `signalKind`, `healthModel`, or `resourceGroup` replaces
 * the signal definition.
 * :::
 *
 * @resource
 */
export const SignalDefinition = GroupedResource<SignalDefinition>(
  "Azure.CloudHealth.SignalDefinition",
);

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  healthModelName: string;
  signalDefinitionName: string;
}

const getDefinition = (where: Where) =>
  orUndefinedIfNotFound(cloudhealth.GetSignalDefinition(where));

const toAttrs = (
  where: Where,
  observed: cloudhealth.GetSignalDefinitionResponse,
): SignalDefinition["Attributes"] => ({
  signalDefinitionName: where.signalDefinitionName,
  signalDefinitionId: observed.id ?? "",
  healthModelName: where.healthModelName,
  resourceGroup: where.resourceGroupName,
  displayName: observed.properties?.displayName,
  signalKind: observed.properties?.signalKind ?? "",
  refreshInterval: observed.properties?.refreshInterval,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.properties?.tags),
});

export const SignalDefinitionProvider = () =>
  Provider.succeed(SignalDefinition, {
    stables: ["signalDefinitionName", "signalDefinitionId", "healthModelName", "resourceGroup"],

    // Definitions live inside a health model; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.healthModel, output.healthModelName) ||
        (news.name !== undefined && !sameName(news.name, output.signalDefinitionName)) ||
        !sameName(news.signalKind, output.signalKind)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const healthModelName = output?.healthModelName ?? olds?.healthModel;
      if (resourceGroupName === undefined || healthModelName === undefined) return undefined;
      const where = {
        subscriptionId,
        resourceGroupName,
        healthModelName,
        signalDefinitionName:
          output?.signalDefinitionName ?? olds?.name ?? (yield* createChildName(id)),
      };
      const observed = yield* getDefinition(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* isOwned(id, observed.properties?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        healthModelName: news.healthModel,
        signalDefinitionName:
          news.name ?? output?.signalDefinitionName ?? (yield* createChildName(id)),
      };
      const tags = yield* desiredTags(id, news.tags);
      const desired = {
        displayName: news.displayName,
        signalKind: news.signalKind,
        metricNamespace: news.metricNamespace,
        metricName: news.metricName,
        aggregationType: news.aggregationType,
        dimensionFilter: news.dimensionFilter,
        queryText: news.queryText,
        valueColumnName: news.valueColumnName,
        timeGrain: news.timeGrain,
        refreshInterval: news.refreshInterval ?? "PT1M",
        dataUnit: news.dataUnit,
        evaluationRules: news.evaluationRules,
      } satisfies cloudhealth.SignalDefinitionPropertiesInput;

      // Observe.
      const observed = yield* getDefinition(where);

      // Ensure + sync: one PUT carries every property.
      if (
        observed === undefined ||
        !isSubset(desired, observed.properties) ||
        tagsDiffer(observed.properties?.tags, tags)
      ) {
        yield* cloudhealth
          .SignalDefinitionsCreateOrUpdate({ ...where, properties: { ...desired, tags } })
          .pipe(Effect.retry(whileBusy));
      }

      const fresh = yield* waitForProvisioned(
        `health model signal definition ${where.signalDefinitionName}`,
        getDefinition(where),
        (definition) => definition.properties?.provisioningState,
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(where, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        healthModelName: output.healthModelName,
        signalDefinitionName: output.signalDefinitionName,
      };
      yield* ignoreNotFound(
        cloudhealth.DeleteSignalDefinition(where).pipe(Effect.retry(whileBusy)),
      );
      yield* waitUntilGone(
        `health model signal definition ${output.signalDefinitionName}`,
        getDefinition(where),
      );
    }),

    nuke: { dependsOn: ["Azure.CloudHealth.HealthModel"] },
  });
