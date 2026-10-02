import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
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
import {
  createLogAnalyticsName,
  ownershipMarker,
  sameText,
  stripMarker,
  withMarker,
} from "./Common.ts";

export type SummaryRuleBinSize = 20 | 30 | 60 | 120 | 180 | 360 | 720 | 1440;

export interface SummaryRuleProps {
  /** Resource group of the workspace. Changing it replaces the rule. */
  resourceGroup: string;
  /** Workspace that holds the rule. Changing it replaces the rule. */
  workspace: string;
  /**
   * Rule name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /** Display name of the rule. */
  displayName?: string;
  /**
   * Rule description. Alchemy appends an `[alchemy <stack>/<stage>/<id>]`
   * ownership marker because summary rules have no tags.
   */
  description?: string;
  /** KQL query that aggregates each bin. */
  query: string;
  /** Bin size in minutes. */
  binSize: SummaryRuleBinSize;
  /** Minutes to wait after a bin closes before running it, to absorb late data. */
  binDelay?: number;
  /**
   * First bin start time (ISO 8601, aligned to the bin size). Changing it
   * replaces the rule.
   */
  binStartTime?: string;
  /**
   * Destination custom table; must end in `_CL`. Azure creates it on first
   * run and keeps it when the rule is deleted. Changing it replaces the
   * rule.
   */
  destinationTable: string;
  /**
   * Whether the rule runs. Set `false` to stop it without deleting it.
   * @default true
   */
  active?: boolean;
}

export interface SummaryRule extends Resource<
  "Azure.LogAnalytics.SummaryRule",
  SummaryRuleProps,
  {
    /** Name of the rule. */
    summaryRuleName: string;
    /** Workspace that holds the rule. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the rule. */
    summaryRuleId: string;
    /** Destination table of the rule. */
    destinationTable: string;
    /** Whether the rule is running. */
    isActive: boolean;
    /** Reason the rule was deactivated (`UserAction`, `DataPlaneError`). */
    statusCode: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Log Analytics summary rule: a scheduled KQL aggregation that writes
 * results for each time bin into a custom `_CL` table, so dashboards and
 * alerts query compact summaries instead of raw logs.
 *
 * Summary rules have no tags, so Alchemy records ownership as a marker at
 * the end of the rule description.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/summary-rules
 *
 * ### Creating a Summary Rule
 * **Example:** Hourly usage summary
 * ```typescript
 * const hourly = yield* Azure.LogAnalytics.SummaryRule("hourly-usage", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 *   query: "Usage | summarize Quantity = sum(Quantity) by DataType",
 *   binSize: 60,
 *   destinationTable: "UsageHourly_CL",
 * });
 * ```
 *
 * ### Pausing a Rule
 * **Example:** Stop the rule without deleting it
 * ```typescript
 * const hourly = yield* Azure.LogAnalytics.SummaryRule("hourly-usage", {
 *   resourceGroup: group.resourceGroupName,
 *   workspace: logs.workspaceName,
 *   query: "Usage | summarize Quantity = sum(Quantity) by DataType",
 *   binSize: 60,
 *   destinationTable: "UsageHourly_CL",
 *   active: false,
 * });
 * ```
 *
 * @resource
 */
export const SummaryRule = Resource<SummaryRule>(
  "Azure.LogAnalytics.SummaryRule",
);

type ObservedRule = operationalinsights.GetSummaryLogResponse;

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  workspaceName: string,
  summaryLogsName: string,
) =>
  orUndefinedIfNotFound(
    operationalinsights.GetSummaryLog({
      subscriptionId,
      resourceGroupName,
      workspaceName,
      summaryLogsName,
    }),
  ).pipe(
    Effect.map((rule) =>
      rule?.properties?.provisioningState === "Deleting" ? undefined : rule,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  workspace: string,
  name: string,
  rule: ObservedRule,
): SummaryRule["Attributes"] => ({
  summaryRuleName: name,
  workspace,
  resourceGroup,
  summaryRuleId: rule.id ?? "",
  destinationTable: rule.properties?.ruleDefinition?.destinationTable ?? "",
  isActive: rule.properties?.isActive ?? false,
  statusCode: rule.properties?.statusCode,
  description: stripMarker(rule.properties?.description),
});

export const SummaryRuleProvider = () =>
  Provider.succeed(SummaryRule, {
    stables: ["summaryRuleName", "workspace", "resourceGroup", "summaryRuleId"],

    // Summary rules live inside a workspace; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.workspace, output.workspace) ||
        (news.name !== undefined &&
          !sameText(news.name, output.summaryRuleName)) ||
        !sameText(news.destinationTable, output.destinationTable) ||
        (olds !== undefined && news.binStartTime !== olds.binStartTime)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const workspace = output?.workspace ?? olds?.workspace;
      if (resourceGroup === undefined || workspace === undefined) {
        return undefined;
      }
      const name =
        output?.summaryRuleName ??
        olds?.name ??
        (yield* createLogAnalyticsName(id, 63));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        workspace,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.description ?? "").endsWith(marker)
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, workspace } = news;
      const name =
        news.name ??
        output?.summaryRuleName ??
        (yield* createLogAnalyticsName(id, 63));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        summaryLogsName: name,
      };
      const description = withMarker(
        news.description,
        yield* ownershipMarker(id),
      );
      const get = getRule(subscriptionId, resourceGroup, workspace, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync the definition: the PUT is an upsert of the whole rule.
      const current = observed?.properties;
      const definition = current?.ruleDefinition;
      if (
        observed === undefined ||
        (current?.description ?? "") !== description ||
        (news.displayName !== undefined &&
          current?.displayName !== news.displayName) ||
        definition?.query !== news.query ||
        definition?.binSize !== news.binSize ||
        (news.binDelay !== undefined && definition?.binDelay !== news.binDelay)
      ) {
        yield* operationalinsights.SummaryLogsCreateOrUpdate({
          ...where,
          properties: {
            ruleType: "User",
            displayName: news.displayName,
            description,
            ruleDefinition: {
              query: news.query,
              binSize: news.binSize,
              binDelay: news.binDelay,
              binStartTime: news.binStartTime,
              timeSelector: "TimeGenerated",
              destinationTable: news.destinationTable,
            },
          },
        });
      }

      let fresh = yield* waitForProvisioned(
        `summary rule ${name}`,
        get,
        (rule) => rule.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Sync the running state against the observed rule.
      const active = news.active ?? true;
      if ((fresh.properties?.isActive ?? false) !== active) {
        yield* active
          ? operationalinsights.StartSummaryLog(where)
          : operationalinsights.StopSummaryLog(where);
        fresh = yield* waitForProvisioned(
          `summary rule ${name}`,
          get,
          (rule) =>
            (rule.properties?.isActive ?? false) === active
              ? rule.properties?.provisioningState
              : "Updating",
          { interval: "3 seconds", times: 40 },
        );
      }

      return toAttrs(resourceGroup, workspace, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        operationalinsights.DeleteSummaryLog({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workspaceName: output.workspace,
          summaryLogsName: output.summaryRuleName,
        }),
      );
      yield* waitUntilGone(
        `summary rule ${output.summaryRuleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.workspace,
          output.summaryRuleName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
