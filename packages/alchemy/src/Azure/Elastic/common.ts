import * as elastic from "@distilled.cloud/azure/elastic";
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
    elastic.GetMonitor({ subscriptionId, resourceGroupName, monitorName }),
  );

/**
 * Whether the monitor is tagged as owned by the current stack and stage.
 * Tag rules, monitored subscriptions, and OpenAI integrations cannot carry
 * tags, so they inherit ownership from their monitor.
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
  /** Name of the Elastic monitor. Changing it replaces the resource. */
  monitor: string;
}

/** Include or exclude Azure resources carrying a tag. */
export interface ElasticFilteringTag {
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

/** Rules for sending Azure logs to Elastic. */
export interface ElasticLogRules {
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
  sendActivityLogs?: boolean;
  /**
   * Resources whose logs are collected. Empty means every resource.
   * @default []
   */
  filteringTags?: ElasticFilteringTag[];
}

/**
 * Log rules with every default filled in, so desired and observed rules
 * compare equal when the service echoes defaults back.
 */
export const normalizeLogRules = (
  rules: ElasticLogRules | elastic.LogRules | undefined,
) => ({
  sendAadLogs: rules?.sendAadLogs ?? false,
  sendSubscriptionLogs: rules?.sendSubscriptionLogs ?? false,
  sendActivityLogs: rules?.sendActivityLogs ?? false,
  filteringTags: (rules?.filteringTags ?? []).map((tag) => ({
    name: tag.name ?? "",
    value: tag.value ?? "",
    action: tag.action ?? "Include",
  })),
});
