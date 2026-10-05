import * as cdn from "@distilled.cloud/azure/cdn";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AFD_DELETE_BUDGET,
  createAlphanumericName,
  profileOwnedByStack,
  sameName,
  waitForAfd,
  whileProfileBusy,
} from "./CdnCommon.ts";

export interface RuleSetProps {
  /** Resource group of the profile. Changing it replaces the rule set. */
  resourceGroup: string;
  /** Front Door profile that holds the rule set. Changing it replaces the rule set. */
  profile: string;
  /**
   * Rule set name: letters and digits, starting with a letter. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the rule set.
   */
  name?: string;
}

export interface RuleSet extends Resource<
  "Azure.Cdn.RuleSet",
  RuleSetProps,
  {
    /** Name of the rule set. */
    ruleSetName: string;
    /** ARM resource ID of the rule set; reference it from routes. */
    ruleSetId: string;
    /** Front Door profile that holds the rule set. */
    profile: string;
    /** Resource group of the profile. */
    resourceGroup: string;
    /** Edge deployment status. */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Front Door rule set — an ordered collection of `Rule`s (header
 * rewrites, redirects, cache overrides) that routes can apply.
 *
 * @see https://learn.microsoft.com/azure/frontdoor/front-door-rules-engine
 *
 * ### Creating a Rule Set
 * **Example:** Rule set attached to a route
 * ```typescript
 * const rules = yield* Azure.Cdn.RuleSet("headers", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 * });
 * const route = yield* Azure.Cdn.Route("default", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   ruleSetIds: [rules.ruleSetId],
 * });
 * ```
 *
 * @resource
 */
export const RuleSet = Resource<RuleSet>("Azure.Cdn.RuleSet");

const getRuleSet = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  ruleSetName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetRuleSet({
      subscriptionId,
      resourceGroupName,
      profileName,
      ruleSetName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  name: string,
  ruleSet: cdn.GetRuleSetResponse,
): RuleSet["Attributes"] => ({
  ruleSetName: name,
  ruleSetId: ruleSet.id ?? "",
  profile,
  resourceGroup,
  deploymentStatus: ruleSet.properties?.deploymentStatus,
});

export const RuleSetProvider = () =>
  Provider.succeed(RuleSet, {
    stables: ["ruleSetName", "ruleSetId", "profile", "resourceGroup"],

    // Rule sets are deleted with their profile.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.profile, output.profile) ||
        (news.name !== undefined && !sameName(news.name, output.ruleSetName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile = output?.profile ?? olds?.profile;
      if (resourceGroup === undefined || profile === undefined)
        return undefined;
      const name =
        output?.ruleSetName ??
        olds?.name ??
        (yield* createAlphanumericName(id));
      const observed = yield* getRuleSet(
        subscriptionId,
        resourceGroup,
        profile,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, name, observed);
      return (yield* profileOwnedByStack(
        subscriptionId,
        resourceGroup,
        profile,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    // Existence-only: a rule set has no mutable settings.
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile } = news;
      const name =
        news.name ?? output?.ruleSetName ?? (yield* createAlphanumericName(id));
      const get = getRuleSet(subscriptionId, resourceGroup, profile, name);

      if ((yield* get) === undefined) {
        yield* cdn
          .CreateRuleSet({
            subscriptionId,
            resourceGroupName: resourceGroup,
            profileName: profile,
            ruleSetName: name,
          })
          .pipe(Effect.retry(whileProfileBusy));
      }
      const observed = yield* waitForAfd(
        `Front Door rule set ${name}`,
        get,
        (r) => r.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, profile, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteRuleSet({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profile,
            ruleSetName: output.ruleSetName,
          })
          .pipe(Effect.retry(whileProfileBusy)),
      );
      yield* waitUntilGone(
        `Front Door rule set ${output.ruleSetName}`,
        getRuleSet(
          subscriptionId,
          output.resourceGroup,
          output.profile,
          output.ruleSetName,
        ),
        AFD_DELETE_BUDGET,
      );
    }),
  });
