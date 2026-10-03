import * as storage from "@distilled.cloud/azure/storage";
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
import { isAccountOwnedByStack } from "./StorageOwnership.ts";

export interface AdvancedPlatformMetricsProps {
  /**
   * Resource group of the storage account. Changing it replaces the rule.
   */
  resourceGroup: string;
  /** Storage account the rule applies to. Changing it replaces the rule. */
  storageAccount: string;
  /**
   * Metrics rule type. Changing it replaces the rule.
   * @default "ContainerLevelCapacityMetrics"
   */
  ruleType?: storage.AdvancedPlatformMetricsRuleType;
  /**
   * Whether the metrics are emitted.
   * @default true
   */
  enabled?: boolean;
  /**
   * Which containers emit metrics: `AllContainersFilter`,
   * `ContainerPrefixFilter` (with prefixes in `filterValues`), or
   * `ContainerListFilter` (with container names in `filterValues`).
   * @default "AllContainersFilter"
   */
  filterType?: storage.AdvancedPlatformMetricsFilterType;
  /**
   * Container prefixes or names, depending on `filterType`.
   * @default []
   */
  filterValues?: string[];
}

export interface AdvancedPlatformMetrics extends Resource<
  "Azure.Storage.AdvancedPlatformMetrics",
  AdvancedPlatformMetricsProps,
  {
    /** Storage account the rule applies to. */
    storageAccount: string;
    /** Resource group of the storage account. */
    resourceGroup: string;
    /** Metrics rule type. */
    ruleType: storage.AdvancedPlatformMetricsRuleType;
    /** ARM resource ID of the rule. */
    advancedPlatformMetricsId: string;
    /** Whether the metrics are emitted. */
    enabled: boolean;
    /** Observed container filter type. */
    filterType: string | undefined;
    /** Observed container filter values. */
    filterValues: string[];
    /** Metrics the rule emits, e.g. `ContainerBlobCount`, `ContainerUsedSize`. */
    metricsEmitted: string[];
  },
  never,
  Providers
> {}

/**
 * An advanced platform metrics rule on a Storage account: opt-in
 * per-container capacity metrics (`ContainerBlobCount`,
 * `ContainerUsedSize`) in Azure Monitor.
 *
 * Each account has at most one rule per rule type. Destroying the resource
 * deletes the rule and stops the extra metrics.
 *
 * ### Container Capacity Metrics
 * **Example:** Metrics for every container
 * ```typescript
 * const account = yield* Azure.Storage.StorageAccount("data", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Storage.AdvancedPlatformMetrics("container-metrics", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 * });
 * ```
 *
 * **Example:** Metrics for containers with a prefix
 * ```typescript
 * yield* Azure.Storage.AdvancedPlatformMetrics("container-metrics", {
 *   resourceGroup: group.resourceGroupName,
 *   storageAccount: account.storageAccountName,
 *   filterType: "ContainerPrefixFilter",
 *   filterValues: ["tenant-"],
 * });
 * ```
 *
 * @resource
 */
export const AdvancedPlatformMetrics = Resource<AdvancedPlatformMetrics>(
  "Azure.Storage.AdvancedPlatformMetrics",
);

const DEFAULT_RULE_TYPE = "ContainerLevelCapacityMetrics" as const;

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  ruleType: string,
) =>
  orUndefinedIfNotFound(
    storage.GetAdvancedPlatformMetrics({
      subscriptionId,
      resourceGroupName,
      accountName,
      advancedPlatformMetricsRuleType: ruleType,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageAccount: string,
  ruleType: storage.AdvancedPlatformMetricsRuleType,
  rule: storage.GetAdvancedPlatformMetricsResponse,
): AdvancedPlatformMetrics["Attributes"] => ({
  storageAccount,
  resourceGroup,
  ruleType,
  advancedPlatformMetricsId: rule.id ?? "",
  enabled: rule.properties?.enabled ?? false,
  filterType: rule.properties?.ruleConfig.filterType,
  filterValues: [...(rule.properties?.ruleConfig.filterValues ?? [])],
  metricsEmitted: [...(rule.properties?.metricsEmitted ?? [])],
});

const sameValues = (
  observed: ReadonlyArray<string> | undefined,
  desired: ReadonlyArray<string>,
) =>
  JSON.stringify([...(observed ?? [])].sort()) ===
  JSON.stringify([...desired].sort());

export const AdvancedPlatformMetricsProvider = () =>
  Provider.succeed(AdvancedPlatformMetrics, {
    stables: [
      "storageAccount",
      "resourceGroup",
      "ruleType",
      "advancedPlatformMetricsId",
    ],

    // Rules disappear with their storage account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageAccount !== output.storageAccount ||
        (news.ruleType ?? DEFAULT_RULE_TYPE) !== output.ruleType
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageAccount = output?.storageAccount ?? olds?.storageAccount;
      if (resourceGroup === undefined || storageAccount === undefined) {
        return undefined;
      }
      const ruleType = output?.ruleType ?? olds?.ruleType ?? DEFAULT_RULE_TYPE;
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        storageAccount,
        ruleType,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageAccount, ruleType, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        storageAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Storage");
      const { resourceGroup, storageAccount } = news;
      const ruleType = news.ruleType ?? DEFAULT_RULE_TYPE;
      const enabled = news.enabled ?? true;
      const filterType = news.filterType ?? "AllContainersFilter";
      const filterValues = news.filterValues ?? [];
      const get = getRule(
        subscriptionId,
        resourceGroup,
        storageAccount,
        ruleType,
      );

      // Observe; the PUT is a full upsert, so only send it on a delta.
      const observed = yield* get;
      if (
        observed === undefined ||
        observed.properties?.enabled !== enabled ||
        observed.properties.ruleConfig.filterType !== filterType ||
        !sameValues(observed.properties.ruleConfig.filterValues, filterValues)
      ) {
        yield* storage.AdvancedPlatformMetricsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: storageAccount,
          advancedPlatformMetricsRuleType: ruleType,
          properties: {
            enabled,
            ruleConfig: {
              filterType,
              filterValues: filterValues.length > 0 ? filterValues : undefined,
            },
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `advanced platform metrics of ${storageAccount}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, storageAccount, ruleType, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storage.DeleteAdvancedPlatformMetrics({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.storageAccount,
          advancedPlatformMetricsRuleType: output.ruleType,
        }),
      );
      yield* waitUntilGone(
        `advanced platform metrics of ${output.storageAccount}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.storageAccount,
          output.ruleType,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Storage.StorageAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
