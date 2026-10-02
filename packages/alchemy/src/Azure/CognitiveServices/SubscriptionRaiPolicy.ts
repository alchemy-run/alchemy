import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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
import { CHILD_BUDGET, createChildName, sameArm } from "./Common.ts";
import {
  desiredRaiPolicy,
  type RaiPolicySettings,
  raiPolicyMatches,
} from "./RaiPolicyShared.ts";

export interface SubscriptionRaiPolicyProps extends RaiPolicySettings {
  /**
   * Policy name, unique in the subscription. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * policy.
   */
  name?: string;
}

export interface SubscriptionRaiPolicy extends Resource<
  "Azure.CognitiveServices.SubscriptionRaiPolicy",
  SubscriptionRaiPolicyProps,
  {
    /** Name of the policy. */
    raiPolicyName: string;
    /** ARM resource ID of the policy. */
    raiPolicyId: string;
    /** Built-in policy the policy derives from. */
    basePolicyName: string | undefined;
    /** Filtering mode. */
    mode: string | undefined;
    /** `UserManaged` or `SystemManaged`. */
    type: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A subscription-wide content-filter (Responsible AI) policy
 * (`Microsoft.CognitiveServices/raiPolicy`) that every Azure OpenAI and
 * Azure AI Foundry account in the subscription can use. Use
 * `CognitiveServices.RaiPolicy` for a policy scoped to one account.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/openai/how-to/content-filters
 *
 * ### Creating a Policy
 * **Example:** Subscription-wide strict policy
 * ```typescript
 * const policy = yield* Azure.CognitiveServices.SubscriptionRaiPolicy("strict", {
 *   mode: "Blocking",
 *   contentFilters: [
 *     { name: "Hate", enabled: true, blocking: true, severityThreshold: "Low", source: "Prompt" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const SubscriptionRaiPolicy = Resource<SubscriptionRaiPolicy>(
  "Azure.CognitiveServices.SubscriptionRaiPolicy",
);

const getPolicy = (subscriptionId: string, raiPolicyName: string) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetSubscriptionRaiPolicy({
      subscriptionId,
      raiPolicyName,
    }),
  );

const toAttrs = (
  name: string,
  policy: cognitiveservices.GetSubscriptionRaiPolicyResponse,
): SubscriptionRaiPolicy["Attributes"] => ({
  raiPolicyName: name,
  raiPolicyId: policy.id ?? "",
  basePolicyName: policy.properties?.basePolicyName,
  mode: policy.properties?.mode,
  type: policy.properties?.type,
  tags: userTags(policy.tags),
});

export const SubscriptionRaiPolicyProvider = () =>
  Provider.succeed(SubscriptionRaiPolicy, {
    stables: ["raiPolicyName", "raiPolicyId"],

    // The API has no list operation for subscription policies.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.name !== undefined &&
        !sameArm(news.name, output.raiPolicyName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name =
        output?.raiPolicyName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getPolicy(subscriptionId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const name =
        news.name ?? output?.raiPolicyName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredRaiPolicy(news);
      const get = getPolicy(subscriptionId, name);

      // Observe; the PUT is a synchronous upsert sent only on a delta.
      const observed = yield* get;
      if (
        !raiPolicyMatches(observed?.properties, properties) ||
        tagsDiffer(observed?.tags, tags)
      ) {
        yield* cognitiveservices.SubscriptionRaiPolicyCreateOrUpdate({
          subscriptionId,
          raiPolicyName: name,
          properties,
          tags,
        });
      }
      const fresh = yield* waitForProvisioned(
        `subscription rai policy ${name}`,
        get,
        () => undefined,
        CHILD_BUDGET,
      );
      return toAttrs(name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices.DeleteSubscriptionRaiPolicy({
          subscriptionId,
          raiPolicyName: output.raiPolicyName,
        }),
      );
      yield* waitUntilGone(
        `subscription rai policy ${output.raiPolicyName}`,
        getPolicy(subscriptionId, output.raiPolicyName),
        CHILD_BUDGET,
      );
    }),
  });
