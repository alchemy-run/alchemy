import * as operationalinsights from "@distilled.cloud/azure/operationalinsights";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createLogAnalyticsName,
  ownershipMarker,
  sameText,
  stripMarker,
  withMarker,
} from "./Common.ts";

/** Bin size of a summary rule in minutes: 20 minutes up to one day (1440). */
export type SummaryRuleBinSize = 20 | 30 | 60 | 120 | 180 | 360 | 720 | 1440;

export interface SummaryRuleProps {
  /**
   * Resource group of the workspace.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the workspace that holds the rule, e.g. `logs.workspaceName`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  workspace: string;
  /**
   * Rule name: letters, digits, hyphens, and underscores, unique in the
   * workspace.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Display name of the rule.
   * @default not sent (Azure shows the rule name)
   */
  displayName?: string;
  /**
   * Rule description. Alchemy appends an `[alchemy <stack>/<stage>/<id>]`
   * ownership marker because summary rules have no tags.
   * @default no description (only the ownership marker)
   */
  description?: string;
  /**
   * KQL query that aggregates each bin, e.g.
   * `Usage | summarize Quantity = sum(Quantity) by DataType`. Alchemy
   * updates it in place.
   */
  query: string;
  /**
   * Bin size in minutes: `20`, `30`, `60`, `120`, `180`, `360`, `720`, or
   * `1440`. The rule runs once per bin. Alchemy updates it in place.
   */
  binSize: SummaryRuleBinSize;
  /**
   * Minutes to wait after a bin closes before the rule runs it, to include
   * late data.
   * @default Azure's default
   */
  binDelay?: number;
  /**
   * Start time of the first bin (ISO 8601), aligned to the bin size, e.g.
   * `2026-01-01T00:00:00Z`.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   * @default Azure's default
   */
  binStartTime?: string;
  /**
   * Destination custom table, ending in `_CL`, e.g. `UsageHourly_CL`. Azure
   * creates it on the first run and keeps it (with its data) when the rule
   * is deleted.
   *
   * :::caution
   * Changing it replaces the rule.
   * :::
   */
  destinationTable: string;
  /**
   * Whether the rule runs. Set `false` to stop it and keep it.
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
    /** Name of the workspace that holds the rule. */
    workspace: string;
    /** Resource group of the workspace. */
    resourceGroup: string;
    /** ARM resource ID of the rule. */
    summaryRuleId: string;
    /** Destination table of the rule, e.g. `UsageHourly_CL`. */
    destinationTable: string;
    /** Whether the rule is running. */
    isActive: boolean;
    /** Reason the rule stopped: `UserAction` or `DataPlaneError`. */
    statusCode: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Log Analytics summary rule
 * (`Microsoft.OperationalInsights/workspaces/summaryLogs`): a scheduled KQL
 * aggregation that writes the result of each time bin into a custom `_CL`
 * table. Dashboards and alerts then query the small summary instead of
 * the raw logs.
 *
 * :::caution[Changing `name`, `destinationTable`, `binStartTime`, `workspace`, or `resourceGroup` replaces the rule]
 * Alchemy creates the new rule and deletes the old one. The old destination
 * table and its data stay in the workspace.
 * :::
 *
 * :::caution[The workspace must exist first]
 * Declare the `Azure.LogAnalytics.Workspace` and pass its `workspaceName`.
 * Azure creates the destination table on the first run.
 * :::
 *
 * Summary rules have no tags, so Alchemy records ownership as a marker at
 * the end of the rule description.
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/logs/summary-rules
 *
 * ### Creating a Summary Rule
 * **Example:** Hourly usage summary
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const hourly = yield* Azure.LogAnalytics.SummaryRule("hourly-usage", {
 *   workspace: logs.workspaceName,
 *   query: "Usage | summarize Quantity = sum(Quantity) by DataType",
 *   binSize: 60,
 *   destinationTable: "UsageHourly_CL",
 * });
 * ```
 *
 * **Example:** Daily summary that waits 15 minutes for late data
 * ```typescript
 * const logs = yield* Azure.LogAnalytics.Workspace("logs");
 * const daily = yield* Azure.LogAnalytics.SummaryRule("daily-errors", {
 *   workspace: logs.workspaceName,
 *   displayName: "Daily errors",
 *   query: "AppExceptions | summarize Count = count() by ProblemId",
 *   binSize: 1440,
 *   binDelay: 15,
 *   destinationTable: "ErrorsDaily_CL",
 * });
 * ```
 *
 * ### Pausing a Rule
 * **Example:** Stop the rule without deleting it
 * ```typescript
 * const hourly = yield* Azure.LogAnalytics.SummaryRule("hourly-usage", {
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
export const SummaryRule = GroupedResource<SummaryRule>("Azure.LogAnalytics.SummaryRule");

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
    Effect.map((rule) => (rule?.properties?.provisioningState === "Deleting" ? undefined : rule)),
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
        (news.name !== undefined && !sameText(news.name, output.summaryRuleName)) ||
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
      const name = output?.summaryRuleName ?? olds?.name ?? (yield* createLogAnalyticsName(id, 63));
      const observed = yield* getRule(subscriptionId, resourceGroup, workspace, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, workspace, name, observed);
      const marker = yield* ownershipMarker(id);
      return (observed.properties?.description ?? "").endsWith(marker) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.OperationalInsights");
      const { resourceGroup, workspace } = news;
      const name = news.name ?? output?.summaryRuleName ?? (yield* createLogAnalyticsName(id, 63));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        workspaceName: workspace,
        summaryLogsName: name,
      };
      const description = withMarker(news.description, yield* ownershipMarker(id));
      const get = getRule(subscriptionId, resourceGroup, workspace, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync the definition: the PUT is an upsert of the whole rule.
      const current = observed?.properties;
      const definition = current?.ruleDefinition;
      if (
        observed === undefined ||
        (current?.description ?? "") !== description ||
        (news.displayName !== undefined && current?.displayName !== news.displayName) ||
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
        getRule(subscriptionId, output.resourceGroup, output.workspace, output.summaryRuleName),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
