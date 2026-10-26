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

/** An action group a Prometheus alerting rule notifies. */
export interface PrometheusRuleAction {
  /**
   * ARM resource ID of the action group to notify
   * (`Microsoft.Insights/actionGroups`).
   */
  actionGroupId?: string;
  /**
   * Properties passed to the action group with the alert.
   * @default {}
   */
  actionProperties?: Record<string, string>;
}

/**
 * A Prometheus recording rule (`record`) or alerting rule (`alert`). Set
 * exactly one of `record` and `alert`.
 */
export interface PrometheusRule {
  /** Name of the time series a recording rule writes, e.g. `job:up:sum`. */
  record?: string;
  /** Name of the alert an alerting rule fires, e.g. `TargetDown`. */
  alert?: string;
  /**
   * Whether the rule is evaluated.
   * @default true
   */
  enabled?: boolean;
  /** PromQL expression evaluated every `interval`, e.g. `up == 0`. */
  expression: string;
  /**
   * Labels added to (or overwritten on) the result.
   * @default {}
   */
  labels?: Record<string, string>;
  /**
   * Alert severity, `0` (critical) to `4` (verbose). Alerting rules only.
   * @default Azure's default
   */
  severity?: 0 | 1 | 2 | 3 | 4;
  /**
   * How long the condition must hold before the alert fires, ISO 8601
   * duration (e.g. `PT5M`). Alerting rules only.
   * @default fires on the first evaluation that matches
   */
  for?: string;
  /**
   * Informational labels such as descriptions or runbook links. Alerting
   * rules only.
   * @default {}
   */
  annotations?: Record<string, string>;
  /**
   * Action groups notified when the alert fires or resolves. Alerting rules
   * only.
   * @default []
   */
  actions?: PrometheusRuleAction[];
  /**
   * How fired alerts are resolved. Alerting rules only.
   * @default Azure's default
   */
  resolveConfiguration?: {
    /** Whether fired alerts are resolved automatically. */
    autoResolved?: boolean;
    /** Healthy duration (ISO 8601, e.g. `PT10M`) before an alert is resolved. */
    timeToResolve?: string;
  };
}

export interface PrometheusRuleGroupProps {
  /**
   * Resource group the rule group is created in.
   *
   * :::caution
   * Changing it replaces the rule group.
   * :::
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Rule group name.
   *
   * :::caution
   * Changing it replaces the rule group.
   * :::
   * @default a name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location; use the Azure Monitor workspace's region.
   *
   * :::caution
   * Changing it replaces the rule group.
   * :::
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM IDs the rules run against: exactly one Azure Monitor workspace
   * (`Microsoft.Monitor/accounts`, e.g. `metrics.workspaceId`), optionally
   * followed by an AKS cluster.
   */
  scopes: string[];
  /** Recording and alerting rules of the group, evaluated in order. */
  rules: PrometheusRule[];
  /**
   * Restrict the rules to series from this cluster (`cluster` label).
   * @default every cluster that writes to the workspace
   */
  clusterName?: string;
  /**
   * Evaluation interval, ISO 8601 duration between `PT1M` and `PT15M`.
   * @default the service default (`PT1M`)
   */
  interval?: string;
  /**
   * Description of the rule group.
   * @default no description
   */
  description?: string;
  /**
   * Whether the rule group is evaluated.
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

export interface PrometheusRuleGroup extends Resource<
  "Azure.Monitor.PrometheusRuleGroup",
  PrometheusRuleGroupProps,
  {
    /** Name of the rule group. */
    ruleGroupName: string;
    /** Resource group that holds the rule group. */
    resourceGroup: string;
    /** ARM resource ID of the rule group. */
    ruleGroupId: string;
    /** Location of the rule group. */
    location: string;
    /** Scopes the rules run against. */
    scopes: string[];
    /** Evaluation interval. */
    interval: string | undefined;
    /** Whether the rule group is enabled. */
    enabled: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Monitor managed Prometheus rule group
 * (`Microsoft.AlertsManagement/prometheusRuleGroups`): Prometheus recording
 * and alerting rules that Azure evaluates against an Azure Monitor
 * workspace. Recording rules write precomputed series back to the
 * workspace; alerting rules fire Azure Monitor alerts and notify action
 * groups.
 *
 * :::caution[Changing `name`, `location`, or `resourceGroup` replaces the rule group]
 * Alchemy creates a new rule group and deletes the old one.
 * :::
 *
 * :::caution[The rule group needs an Azure Monitor workspace]
 * Declare an `Azure.Monitor.Workspace` first, pass its `workspaceId` as the
 * first scope, and create the rule group in the workspace's region.
 * :::
 *
 * :::caution[Alert actions need an existing action group]
 * Alchemy has no action group resource yet. Create the action group
 * (`Microsoft.Insights/actionGroups`) outside Alchemy and pass its ARM ID.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-monitor/essentials/prometheus-rule-groups
 *
 * ### Recording Rules
 * **Example:** Precompute a per-namespace CPU rate
 * ```typescript
 * const metrics = yield* Azure.Monitor.Workspace("metrics");
 * const rules = yield* Azure.Monitor.PrometheusRuleGroup("recording", {
 *   location: metrics.location,
 *   scopes: [metrics.workspaceId],
 *   interval: "PT1M",
 *   rules: [
 *     {
 *       record: "namespace:container_cpu:rate5m",
 *       expression:
 *         "sum by (namespace) (rate(container_cpu_usage_seconds_total[5m]))",
 *     },
 *   ],
 * });
 * ```
 *
 * ### Alerting Rules
 * **Example:** Alert on a down scrape target and notify an action group
 * ```typescript
 * // an action group created outside Alchemy
 * const oncallId =
 *   "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/ops/providers/Microsoft.Insights/actionGroups/oncall";
 * const metrics = yield* Azure.Monitor.Workspace("metrics");
 * const alerts = yield* Azure.Monitor.PrometheusRuleGroup("alerts", {
 *   location: metrics.location,
 *   scopes: [metrics.workspaceId],
 *   clusterName: "prod-aks",
 *   rules: [
 *     {
 *       alert: "TargetDown",
 *       expression: "up == 0",
 *       for: "PT5M",
 *       severity: 2,
 *       annotations: { summary: "Scrape target is down" },
 *       actions: [{ actionGroupId: oncallId }],
 *       resolveConfiguration: { autoResolved: true, timeToResolve: "PT10M" },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const PrometheusRuleGroup = GroupedResource<PrometheusRuleGroup>(
  "Azure.Monitor.PrometheusRuleGroup",
);

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const sameLocation = (a: string, b: string) =>
  sameText(a.replaceAll(" ", ""), b.replaceAll(" ", ""));

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

const createGroupName = (id: string) =>
  createPhysicalName({ id, maxLength: 260 }).pipe(
    Effect.map((name) => name.replace(/[<>*%{}&:\\?+/#|]/g, "-")),
  );

const getGroup = (subscriptionId: string, resourceGroupName: string, ruleGroupName: string) =>
  orUndefinedIfNotFound(
    alertsmanagement.GetPrometheusRuleGroup({
      subscriptionId,
      resourceGroupName,
      ruleGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  group: alertsmanagement.PrometheusRuleGroupResource,
): PrometheusRuleGroup["Attributes"] => ({
  ruleGroupName: name,
  resourceGroup,
  ruleGroupId: group.id ?? "",
  location: group.location,
  scopes: [...(group.properties?.scopes ?? [])],
  interval: group.properties?.interval,
  enabled: group.properties?.enabled ?? true,
  tags: userTags(group.tags),
});

const toProperties = (
  news: PrometheusRuleGroupProps,
): alertsmanagement.PrometheusRuleGroupProperties => ({
  scopes: news.scopes,
  rules: news.rules,
  clusterName: news.clusterName,
  interval: news.interval,
  description: news.description,
  enabled: news.enabled ?? true,
});

export const PrometheusRuleGroupProvider = () =>
  Provider.succeed(PrometheusRuleGroup, {
    stables: ["ruleGroupName", "resourceGroup", "ruleGroupId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(alertsmanagement.ListPrometheusRuleGroupBySubscription, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((group) => {
        const rg = resourceGroupOf(group.id);
        return hasAnyAlchemyTag(group.tags) && rg !== undefined && group.name !== undefined
          ? [toAttrs(rg, group.name, group)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameText(news.name, output.ruleGroupName)) ||
        (news.location !== undefined && !sameLocation(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.ruleGroupName ?? olds?.name ?? (yield* createGroupName(id));
      const observed = yield* getGroup(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.AlertsManagement");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.ruleGroupName ?? (yield* createGroupName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        ruleGroupName: name,
      };
      const get = getGroup(subscriptionId, resourceGroup, name);
      const properties = toProperties(news);

      // Observe.
      const observed = yield* get;

      // Ensure / sync. PUT is a synchronous full-body upsert, so a missing
      // group or any property delta re-PUTs the desired body; tag-only
      // deltas PATCH just the tags.
      if (
        observed === undefined ||
        !subsetOf(properties, observed.properties) ||
        (news.clusterName === undefined && observed.properties?.clusterName !== undefined) ||
        (news.description === undefined && observed.properties?.description !== undefined)
      ) {
        yield* alertsmanagement.PrometheusRuleGroupsCreateOrUpdate({
          ...where,
          location: observed?.location ?? news.location ?? env.location,
          tags,
          properties,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* alertsmanagement.UpdatePrometheusRuleGroup({ ...where, tags });
      }

      const final = yield* waitForProvisioned(
        `prometheus rule group ${name}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(resourceGroup, name, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        alertsmanagement.DeletePrometheusRuleGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          ruleGroupName: output.ruleGroupName,
        }),
      );
      yield* waitUntilGone(
        `prometheus rule group ${output.ruleGroupName}`,
        getGroup(subscriptionId, output.resourceGroup, output.ruleGroupName),
        { interval: "3 seconds", times: 40 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
