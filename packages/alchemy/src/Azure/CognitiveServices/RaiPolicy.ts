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
import {
  CHILD_BUDGET,
  createChildName,
  sameArm,
  whileAccountBusy,
} from "./Common.ts";
import {
  desiredRaiPolicy,
  type RaiPolicySettings,
  raiPolicyMatches,
} from "./RaiPolicyShared.ts";

export interface RaiPolicyProps extends RaiPolicySettings {
  /** Resource group of the account. Changing it replaces the policy. */
  resourceGroup: string;
  /**
   * Account (kind `OpenAI` or `AIServices`) that holds the policy.
   * Changing it replaces the policy.
   */
  account: string;
  /**
   * Policy name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the policy.
   */
  name?: string;
}

export interface RaiPolicy extends Resource<
  "Azure.CognitiveServices.RaiPolicy",
  RaiPolicyProps,
  {
    /** Name of the policy; reference it from `Deployment.raiPolicyName`. */
    raiPolicyName: string;
    /** ARM resource ID of the policy. */
    raiPolicyId: string;
    /** Account that holds the policy. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
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
 * A content-filter (Responsible AI) policy
 * (`Microsoft.CognitiveServices/accounts/raiPolicies`) applied to model
 * deployments of an Azure OpenAI or Azure AI Foundry account. It sets the
 * severity thresholds of the built-in filters and attaches custom
 * blocklists.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/openai/how-to/content-filters
 *
 * ### Creating a Policy
 * **Example:** Stricter hate and violence filters
 * ```typescript
 * const policy = yield* Azure.CognitiveServices.RaiPolicy("strict", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   mode: "Blocking",
 *   contentFilters: [
 *     { name: "Hate", enabled: true, blocking: true, severityThreshold: "Low", source: "Prompt" },
 *     { name: "Violence", enabled: true, blocking: true, severityThreshold: "Low", source: "Completion" },
 *   ],
 * });
 * ```
 *
 * ### Custom Blocklists
 * **Example:** Attach a blocklist to prompts
 * ```typescript
 * const policy = yield* Azure.CognitiveServices.RaiPolicy("strict", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   customBlocklists: [
 *     { blocklistName: blocklist.raiBlocklistName, blocking: true, source: "Prompt" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const RaiPolicy = Resource<RaiPolicy>(
  "Azure.CognitiveServices.RaiPolicy",
);

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  raiPolicyName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetRaiPolicy({
      subscriptionId,
      resourceGroupName,
      accountName,
      raiPolicyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  policy: cognitiveservices.GetRaiPolicyResponse,
): RaiPolicy["Attributes"] => ({
  raiPolicyName: name,
  raiPolicyId: policy.id ?? "",
  account,
  resourceGroup,
  basePolicyName: policy.properties?.basePolicyName,
  mode: policy.properties?.mode,
  type: policy.properties?.type,
  tags: userTags(policy.tags),
});

export const RaiPolicyProvider = () =>
  Provider.succeed(RaiPolicy, {
    stables: ["raiPolicyName", "raiPolicyId", "account", "resourceGroup"],

    // Policies live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account) ||
        (news.name !== undefined && !sameArm(news.name, output.raiPolicyName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.raiPolicyName ?? olds?.name ?? (yield* createChildName(id));
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.raiPolicyName ?? (yield* createChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredRaiPolicy(news);
      const get = getPolicy(subscriptionId, resourceGroup, account, name);

      // Observe; the PUT is a synchronous upsert sent only on a delta.
      const observed = yield* get;
      if (
        !raiPolicyMatches(observed?.properties, properties) ||
        tagsDiffer(observed?.tags, tags)
      ) {
        yield* cognitiveservices
          .RaiPoliciesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            raiPolicyName: name,
            properties,
            tags,
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `rai policy ${name}`,
        get,
        () => undefined,
        CHILD_BUDGET,
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteRaiPolicy({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            raiPolicyName: output.raiPolicyName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `rai policy ${output.raiPolicyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.raiPolicyName,
        ),
        CHILD_BUDGET,
      );
    }),
  });
