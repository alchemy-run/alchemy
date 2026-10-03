import * as datadog from "@distilled.cloud/azure/datadog";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonicalJson,
  DEFAULT_CONFIGURATION,
  type DatadogAgentRules,
  type DatadogLogRules,
  type DatadogMetricRules,
  isMonitorOwnedByStack,
  type MonitorChildProps,
  normalizeTagRules,
  sameName,
} from "./common.ts";

export interface TagRuleProps extends MonitorChildProps {
  /** Log collection rules. Omitted rules send no logs. */
  logRules?: DatadogLogRules;
  /** Metric collection rules. Omitted rules collect every resource. */
  metricRules?: DatadogMetricRules;
  /** Datadog agent management rules. */
  agentRules?: DatadogAgentRules;
  /**
   * Mute Datadog monitors while Azure VMs are shut down.
   * @default false
   */
  automuting?: boolean;
  /**
   * Send Application Insights custom metrics.
   * @default false
   */
  customMetrics?: boolean;
}

export interface TagRule extends Resource<
  "Azure.Datadog.TagRule",
  TagRuleProps,
  {
    /** Name of the Datadog monitor. */
    monitor: string;
    /** Resource group of the monitor. */
    resourceGroup: string;
    /** Name of the rule set (always `default`). */
    ruleSetName: string;
    /** ARM resource ID of the rule set. */
    tagRuleId: string;
    /** Provisioning state of the rule set. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The tag rules of a Datadog monitor (`Microsoft.Datadog/monitors/tagRules`,
 * singleton `default`): which Azure logs and metrics are sent to Datadog,
 * filtered by resource tags, and whether the Datadog agent is managed on
 * Azure VMs.
 *
 * The rule set always exists while its monitor exists; deleting the
 * resource resets it to the defaults (no logs, every resource's metrics).
 *
 * ### Sending Logs and Metrics
 * **Example:** Send resource logs for tagged resources
 * ```typescript
 * const rules = yield* Azure.Datadog.TagRule("rules", {
 *   resourceGroup: group.resourceGroupName,
 *   monitor: monitor.monitorName,
 *   logRules: {
 *     sendSubscriptionLogs: true,
 *     sendResourceLogs: true,
 *     filteringTags: [{ name: "datadog", value: "true", action: "Include" }],
 *   },
 *   metricRules: {
 *     filteringTags: [{ name: "env", value: "dev", action: "Exclude" }],
 *   },
 * });
 * ```
 *
 * ### Muting
 * **Example:** Mute monitors while VMs are stopped
 * ```typescript
 * const rules = yield* Azure.Datadog.TagRule("rules", {
 *   resourceGroup: group.resourceGroupName,
 *   monitor: monitor.monitorName,
 *   automuting: true,
 * });
 * ```
 *
 * @resource
 */
export const TagRule = Resource<TagRule>("Azure.Datadog.TagRule");

const getTagRule = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) =>
  orUndefinedIfNotFound(
    datadog.GetTagRule({
      subscriptionId,
      resourceGroupName,
      monitorName,
      ruleSetName: DEFAULT_CONFIGURATION,
    }),
  );

const desiredRules = (
  news: TagRuleProps,
): datadog.MonitoringTagRulesPropertiesInput => {
  const normalized = normalizeTagRules(news);
  return {
    ...normalized,
    logRules: {
      ...normalized.logRules,
      filteringTags: news.logRules?.filteringTags ?? [],
    },
    metricRules: { filteringTags: news.metricRules?.filteringTags ?? [] },
    agentRules: {
      ...normalized.agentRules,
      filteringTags: news.agentRules?.filteringTags ?? [],
    },
  };
};

const toAttrs = (
  resourceGroup: string,
  monitor: string,
  observed: datadog.GetTagRuleResponse,
): TagRule["Attributes"] => ({
  monitor,
  resourceGroup,
  ruleSetName: DEFAULT_CONFIGURATION,
  tagRuleId: observed.id ?? "",
  provisioningState: observed.properties?.provisioningState,
});

export const TagRuleProvider = () =>
  Provider.succeed(TagRule, {
    stables: ["monitor", "resourceGroup", "ruleSetName", "tagRuleId"],

    // The rule set lives and dies with its monitor, which `list` covers.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.monitor, output.monitor)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const monitor = output?.monitor ?? olds?.monitor;
      if (resourceGroup === undefined || monitor === undefined) {
        return undefined;
      }
      const observed = yield* getTagRule(
        subscriptionId,
        resourceGroup,
        monitor,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, monitor, observed);
      return (yield* isMonitorOwnedByStack(
        subscriptionId,
        resourceGroup,
        monitor,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Datadog");
      const { resourceGroup, monitor } = news;

      // Observe: the singleton exists as soon as the monitor does.
      let observed = yield* getTagRule(subscriptionId, resourceGroup, monitor);

      // Ensure + sync: one PUT when the observed rules drift.
      if (
        observed === undefined ||
        canonicalJson(normalizeTagRules(observed.properties)) !==
          canonicalJson(normalizeTagRules(news))
      ) {
        yield* datadog.TagRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          monitorName: monitor,
          ruleSetName: DEFAULT_CONFIGURATION,
          properties: desiredRules(news),
        });
        observed = yield* waitForProvisioned(
          `Datadog tag rules of ${monitor}`,
          getTagRule(subscriptionId, resourceGroup, monitor),
          (rule) => rule.properties?.provisioningState,
          { interval: "5 seconds", times: 36 },
        );
      }

      return toAttrs(resourceGroup, monitor, observed);
    }),

    // There is no DELETE: reset the singleton to its defaults. A missing
    // monitor means the rules are already gone.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        datadog.TagRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitor,
          ruleSetName: DEFAULT_CONFIGURATION,
          properties: desiredRules({
            resourceGroup: output.resourceGroup,
            monitor: output.monitor,
          }),
        }),
      );
    }),

    nuke: { dependsOn: ["Azure.Datadog.Monitor"] },
  });
