import * as elastic from "@distilled.cloud/azure/elastic";
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
  type ElasticLogRules,
  isMonitorOwnedByStack,
  type MonitorChildProps,
  normalizeLogRules,
  sameName,
} from "./common.ts";

export interface TagRuleProps extends MonitorChildProps {
  /** Which Azure logs are sent to Elastic. Omitted rules send no logs. */
  logRules?: ElasticLogRules;
}

export interface TagRule extends Resource<
  "Azure.Elastic.TagRule",
  TagRuleProps,
  {
    /** Name of the Elastic monitor. */
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
 * The log rules of an Elastic monitor (`Microsoft.Elastic/monitors/tagRules`,
 * singleton `default`): which Microsoft Entra ID, subscription activity,
 * and resource logs are shipped to Elastic, filtered by resource tags.
 *
 * ### Sending Logs
 * **Example:** Send resource logs for tagged resources
 * ```typescript
 * const rules = yield* Azure.Elastic.TagRule("rules", {
 *   resourceGroup: group.resourceGroupName,
 *   monitor: monitor.monitorName,
 *   logRules: {
 *     sendSubscriptionLogs: true,
 *     sendActivityLogs: true,
 *     filteringTags: [{ name: "elastic", value: "true", action: "Include" }],
 *   },
 * });
 * ```
 *
 * ### Excluding Resources
 * **Example:** Ship every resource's logs except dev ones
 * ```typescript
 * const rules = yield* Azure.Elastic.TagRule("rules", {
 *   resourceGroup: group.resourceGroupName,
 *   monitor: monitor.monitorName,
 *   logRules: {
 *     sendActivityLogs: true,
 *     filteringTags: [{ name: "env", value: "dev", action: "Exclude" }],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const TagRule = Resource<TagRule>("Azure.Elastic.TagRule");

const getTagRule = (
  subscriptionId: string,
  resourceGroupName: string,
  monitorName: string,
) =>
  orUndefinedIfNotFound(
    elastic.GetTagRule({
      subscriptionId,
      resourceGroupName,
      monitorName,
      ruleSetName: DEFAULT_CONFIGURATION,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  monitor: string,
  observed: elastic.GetTagRuleResponse,
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
      yield* ensureRegistered(subscriptionId, "Microsoft.Elastic");
      const { resourceGroup, monitor } = news;

      // Observe.
      let observed = yield* getTagRule(subscriptionId, resourceGroup, monitor);

      // Ensure + sync: one PUT when the rule set is missing or drifted.
      const desired = normalizeLogRules(news.logRules);
      if (
        observed === undefined ||
        canonicalJson(normalizeLogRules(observed.properties?.logRules)) !==
          canonicalJson(desired)
      ) {
        yield* elastic.TagRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          monitorName: monitor,
          ruleSetName: DEFAULT_CONFIGURATION,
          properties: { logRules: desired },
        });
        observed = yield* waitForProvisioned(
          `Elastic tag rules of ${monitor}`,
          getTagRule(subscriptionId, resourceGroup, monitor),
          (rule) => rule.properties?.provisioningState,
          { interval: "5 seconds", times: 36 },
        );
      }

      return toAttrs(resourceGroup, monitor, observed);
    }),

    // A missing monitor means the rules are already gone. The service may
    // keep (or re-create) an empty `default` rule set while the monitor
    // lives, so there is nothing further to wait for.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        elastic.DeleteTagRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          monitorName: output.monitor,
          ruleSetName: DEFAULT_CONFIGURATION,
        }),
      );
    }),

    nuke: { dependsOn: ["Azure.Elastic.Monitor"] },
  });
