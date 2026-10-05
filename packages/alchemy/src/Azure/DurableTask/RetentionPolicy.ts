import * as durabletask from "@distilled.cloud/azure/durabletask";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { getScheduler } from "./Scheduler.ts";

export type PurgeableOrchestrationState =
  | "Completed"
  | "Failed"
  | "Terminated"
  | "Canceled";

export interface RetentionRule {
  /** Days after which a finished orchestration is purged automatically. */
  retentionPeriodInDays: number;
  /**
   * Orchestration state the rule applies to. Omit it for the default rule
   * that covers every purgeable state without a more specific rule.
   */
  orchestrationState?: PurgeableOrchestrationState;
}

export interface RetentionPolicyProps {
  /** Resource group of the scheduler. Changing it replaces the policy. */
  resourceGroup: string;
  /** Scheduler the policy applies to. Changing it replaces the policy. */
  scheduler: string;
  /**
   * Retention rules. At most one rule per orchestration state, plus at most
   * one default rule without `orchestrationState`.
   */
  retentionPolicies: RetentionRule[];
}

export interface RetentionPolicy extends Resource<
  "Azure.DurableTask.RetentionPolicy",
  RetentionPolicyProps,
  {
    /** Scheduler the policy applies to. */
    scheduler: string;
    /** Resource group of the scheduler. */
    resourceGroup: string;
    /** ARM resource ID of the policy (`.../retentionPolicies/default`). */
    retentionPolicyId: string;
    /** Retention rules applied by the scheduler. */
    retentionPolicies: RetentionRule[];
  },
  never,
  Providers
> {}

/**
 * The orchestration retention policy of a Durable Task Scheduler — how many
 * days completed, failed, terminated, or canceled orchestrations are kept
 * before the scheduler purges them. Each scheduler has a single policy
 * (`default`); deleting it restores the service defaults.
 *
 * @see https://learn.microsoft.com/azure/azure-functions/durable/durable-task-scheduler/durable-task-scheduler
 *
 * ### Configuring Retention
 * **Example:** Keep everything 7 days, failures 30 days
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.DurableTask.RetentionPolicy("retention", {
 *   resourceGroup: group.resourceGroupName,
 *   scheduler: scheduler.schedulerName,
 *   retentionPolicies: [
 *     { retentionPeriodInDays: 7 },
 *     { retentionPeriodInDays: 30, orchestrationState: "Failed" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const RetentionPolicy = Resource<RetentionPolicy>(
  "Azure.DurableTask.RetentionPolicy",
);

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  schedulerName: string,
) =>
  orUndefinedIfNotFound(
    durabletask.GetRetentionPolicy({
      subscriptionId,
      resourceGroupName,
      schedulerName,
    }),
  );

const rulesOf = (
  policy: durabletask.GetRetentionPolicyResponse,
): RetentionRule[] =>
  (policy.properties?.retentionPolicies ?? []).map((rule) => ({
    retentionPeriodInDays: rule.retentionPeriodInDays,
    ...(rule.orchestrationState !== undefined
      ? {
          orchestrationState:
            rule.orchestrationState as PurgeableOrchestrationState,
        }
      : {}),
  }));

const ruleKey = (rules: readonly RetentionRule[]) =>
  rules
    .map((r) => `${r.orchestrationState ?? "*"}=${r.retentionPeriodInDays}`)
    .sort()
    .join(",");

const toAttrs = (
  resourceGroup: string,
  scheduler: string,
  policy: durabletask.GetRetentionPolicyResponse,
): RetentionPolicy["Attributes"] => ({
  scheduler,
  resourceGroup,
  retentionPolicyId: policy.id ?? "",
  retentionPolicies: rulesOf(policy),
});

export const RetentionPolicyProvider = () =>
  Provider.succeed(RetentionPolicy, {
    stables: ["scheduler", "resourceGroup", "retentionPolicyId"],

    // The policy lives inside a scheduler; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.scheduler.toLowerCase() !== output.scheduler.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const scheduler = output?.scheduler ?? olds?.scheduler;
      if (resourceGroup === undefined || scheduler === undefined) {
        return undefined;
      }
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        scheduler,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, scheduler, observed);
      const parent = yield* getScheduler(
        subscriptionId,
        resourceGroup,
        scheduler,
      );
      const { stack, stage } = yield* stackAndStage;
      const tags = tagRecord(parent?.tags);
      return tags["alchemy::stack"] === stack &&
        tags["alchemy::stage"] === stage
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DurableTask");
      const { resourceGroup, scheduler } = news;
      const desired = news.retentionPolicies;
      const get = getPolicy(subscriptionId, resourceGroup, scheduler);
      const label = `durable task retention policy on ${scheduler}`;

      // Observe; ensure + sync in one idempotent full replace when the
      // observed rules differ from the desired rules.
      const observed = yield* get;
      if (
        observed === undefined ||
        ruleKey(rulesOf(observed)) !== ruleKey(desired)
      ) {
        yield* durabletask.RetentionPoliciesCreateOrReplace({
          subscriptionId,
          resourceGroupName: resourceGroup,
          schedulerName: scheduler,
          properties: {
            retentionPolicies: desired.map((rule) => ({
              retentionPeriodInDays: rule.retentionPeriodInDays,
              orchestrationState: rule.orchestrationState,
            })),
          },
        });
      }
      const ready = yield* waitForProvisioned(
        label,
        get,
        (policy) => policy.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, scheduler, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        durabletask.DeleteRetentionPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          schedulerName: output.scheduler,
        }),
      );
      yield* waitUntilGone(
        `durable task retention policy on ${output.scheduler}`,
        getPolicy(subscriptionId, output.resourceGroup, output.scheduler),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.DurableTask.Scheduler",
      ],
    },
  });
