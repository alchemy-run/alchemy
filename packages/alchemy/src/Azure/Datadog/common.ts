import * as datadog from "@distilled.cloud/azure/datadog";
import * as Effect from "effect/Effect";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Case-insensitive comparison for ARM names, groups, and locations. */
export const sameName = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Stable JSON for order-insensitive comparison of plain objects. */
export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );

/** The only configuration name the monitor singletons accept. */
export const DEFAULT_CONFIGURATION = "default";

export const getMonitor = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) =>
  orUndefinedIfNotFound(
    datadog.GetMonitor({ subscriptionId, resourceGroupName, monitorName }),
  );

/**
 * Whether the monitor is tagged as owned by the current stack and stage.
 * Tag rules, single sign-on, and monitored subscriptions cannot carry tags,
 * so they inherit ownership from their monitor.
 */
export const isMonitorOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) {
  const monitor = yield* getMonitor(
    subscriptionId,
    resourceGroupName,
    monitorName,
  );
  if (monitor === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(monitor.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

/** Location props shared by every monitor child. */
export interface MonitorChildProps {
  /** Resource group of the monitor. Changing it replaces the resource. */
  resourceGroup: string;
  /** Name of the Datadog monitor. Changing it replaces the resource. */
  monitor: string;
}

/** Include or exclude Azure resources carrying a tag. */
export interface DatadogFilteringTag {
  /** Tag name (key). */
  name: string;
  /** Tag value. Omit to match any value. */
  value?: string;
  /**
   * Whether matching resources are included or excluded. Exclusion wins
   * over inclusion.
   * @default "Include"
   */
  action?: "Include" | "Exclude";
}

/** Rules for sending Azure logs to Datadog. */
export interface DatadogLogRules {
  /**
   * Send Microsoft Entra ID (AAD) logs.
   * @default false
   */
  sendAadLogs?: boolean;
  /**
   * Send Azure subscription activity logs.
   * @default false
   */
  sendSubscriptionLogs?: boolean;
  /**
   * Send Azure resource logs.
   * @default false
   */
  sendResourceLogs?: boolean;
  /**
   * Resources whose logs are collected. Empty means every resource.
   * @default []
   */
  filteringTags?: DatadogFilteringTag[];
}

/** Rules for sending Azure metrics to Datadog. */
export interface DatadogMetricRules {
  /**
   * Resources whose metrics are collected. Empty means every resource.
   * @default []
   */
  filteringTags?: DatadogFilteringTag[];
}

/** Rules for managing the Datadog agent on Azure VMs. */
export interface DatadogAgentRules {
  /**
   * Install and manage the Datadog agent on matching VMs.
   * @default false
   */
  enableAgentMonitoring?: boolean;
  /**
   * VMs the agent is managed on. Empty means every VM.
   * @default []
   */
  filteringTags?: DatadogFilteringTag[];
}

/** What a monitor (or a monitored subscription) sends to Datadog. */
export interface DatadogTagRules {
  /** Log collection rules. */
  logRules?: DatadogLogRules;
  /** Metric collection rules. */
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

const normalizeFilteringTags = (
  tags: ReadonlyArray<datadog.FilteringTag> | undefined,
) =>
  (tags ?? []).map((tag) => ({
    name: tag.name ?? "",
    value: tag.value ?? "",
    action: tag.action ?? "Include",
  }));

/**
 * Tag rules with every default filled in, so desired and observed rules
 * compare equal when the service echoes defaults back.
 */
export const normalizeTagRules = (
  rules: DatadogTagRules | datadog.MonitoringTagRulesProperties | undefined,
) => ({
  logRules: {
    sendAadLogs: rules?.logRules?.sendAadLogs ?? false,
    sendSubscriptionLogs: rules?.logRules?.sendSubscriptionLogs ?? false,
    sendResourceLogs: rules?.logRules?.sendResourceLogs ?? false,
    filteringTags: normalizeFilteringTags(rules?.logRules?.filteringTags),
  },
  metricRules: {
    filteringTags: normalizeFilteringTags(rules?.metricRules?.filteringTags),
  },
  agentRules: {
    enableAgentMonitoring: rules?.agentRules?.enableAgentMonitoring ?? false,
    filteringTags: normalizeFilteringTags(rules?.agentRules?.filteringTags),
  },
  automuting: rules?.automuting ?? false,
  customMetrics: rules?.customMetrics ?? false,
});
