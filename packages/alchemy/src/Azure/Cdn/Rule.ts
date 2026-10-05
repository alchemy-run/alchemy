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
  changedFields,
  createAlphanumericName,
  profileOwnedByStack,
  sameName,
  waitForAfd,
  whileProfileBusy,
} from "./CdnCommon.ts";

/**
 * A rule condition, e.g. `{ name: "UrlPath", parameters: { typeName:
 * "DeliveryRuleUrlPathMatchConditionParameters", operator: "BeginsWith",
 * matchValues: ["/api"] } }`.
 */
export interface AfdRuleCondition {
  /** Condition kind: `RequestMethod`, `UrlPath`, `RequestHeader`, `HostName`, ... */
  name: string;
  /** Condition parameters; `typeName` selects the parameter schema. */
  parameters: Record<string, unknown>;
}

/**
 * A rule action, e.g. `{ name: "ModifyResponseHeader", parameters: {
 * typeName: "DeliveryRuleHeaderActionParameters", headerAction: "Overwrite",
 * headerName: "X-Frame-Options", value: "DENY" } }`.
 */
export interface AfdRuleAction {
  /** Action kind: `ModifyResponseHeader`, `UrlRedirect`, `UrlRewrite`, `RouteConfigurationOverride`, ... */
  name: string;
  /** Action parameters; `typeName` selects the parameter schema. */
  parameters: Record<string, unknown>;
}

export interface RuleProps {
  /** Resource group of the profile. Changing it replaces the rule. */
  resourceGroup: string;
  /** Front Door profile that holds the rule set. Changing it replaces the rule. */
  profile: string;
  /** Rule set the rule belongs to. Changing it replaces the rule. */
  ruleSet: string;
  /**
   * Rule name: letters and digits, starting with a letter. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the rule.
   */
  name?: string;
  /**
   * Evaluation order within the rule set (unique). A rule with order `0`
   * takes no conditions and always applies.
   */
  order: number;
  /** Conditions that must all match for the actions to run. */
  conditions?: AfdRuleCondition[];
  /** Actions to run when the conditions match. */
  actions: AfdRuleAction[];
  /**
   * Whether later rules still run after this one matches.
   * @default "Continue"
   */
  matchProcessingBehavior?: "Continue" | "Stop";
}

export interface Rule extends Resource<
  "Azure.Cdn.Rule",
  RuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Rule set that holds the rule. */
    ruleSet: string;
    /** Front Door profile that holds the rule set. */
    profile: string;
    /** Resource group of the profile. */
    resourceGroup: string;
    /** Evaluation order. */
    order: number | undefined;
    /** Edge deployment status. */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Front Door rules-engine rule: conditions plus actions (header rewrites,
 * redirects, URL rewrites, cache overrides) inside a `RuleSet`.
 *
 * @see https://learn.microsoft.com/azure/frontdoor/front-door-rules-engine-actions
 *
 * ### Creating a Rule
 * **Example:** Add a security header to every response
 * ```typescript
 * const rule = yield* Azure.Cdn.Rule("frameOptions", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   ruleSet: rules.ruleSetName,
 *   order: 1,
 *   actions: [
 *     {
 *       name: "ModifyResponseHeader",
 *       parameters: {
 *         typeName: "DeliveryRuleHeaderActionParameters",
 *         headerAction: "Overwrite",
 *         headerName: "X-Frame-Options",
 *         value: "DENY",
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Redirect a path
 * ```typescript
 * const redirect = yield* Azure.Cdn.Rule("oldDocs", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   ruleSet: rules.ruleSetName,
 *   order: 2,
 *   conditions: [
 *     {
 *       name: "UrlPath",
 *       parameters: {
 *         typeName: "DeliveryRuleUrlPathMatchConditionParameters",
 *         operator: "BeginsWith",
 *         matchValues: ["/old-docs"],
 *       },
 *     },
 *   ],
 *   actions: [
 *     {
 *       name: "UrlRedirect",
 *       parameters: {
 *         typeName: "DeliveryRuleUrlRedirectActionParameters",
 *         redirectType: "Moved",
 *         customPath: "/docs",
 *       },
 *     },
 *   ],
 *   matchProcessingBehavior: "Stop",
 * });
 * ```
 *
 * @resource
 */
export const Rule = Resource<Rule>("Azure.Cdn.Rule");

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  ruleSetName: string,
  ruleName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetRule({
      subscriptionId,
      resourceGroupName,
      profileName,
      ruleSetName,
      ruleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  ruleSet: string,
  name: string,
  rule: cdn.GetRuleResponse,
): Rule["Attributes"] => ({
  ruleName: name,
  ruleId: rule.id ?? "",
  ruleSet,
  profile,
  resourceGroup,
  order: rule.properties?.order,
  deploymentStatus: rule.properties?.deploymentStatus,
});

export const RuleProvider = () =>
  Provider.succeed(Rule, {
    stables: ["ruleName", "ruleId", "ruleSet", "profile", "resourceGroup"],

    // Rules are deleted with their rule set and profile.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameRuleSet =
        sameName(news.resourceGroup, output.resourceGroup) &&
        sameName(news.profile, output.profile) &&
        sameName(news.ruleSet, output.ruleSet);
      if (
        !sameRuleSet ||
        (news.name !== undefined && !sameName(news.name, output.ruleName))
      ) {
        // Orders are unique within a rule set: a renamed rule that keeps its
        // order can only be created after the old one is gone.
        return {
          action: "replace",
          deleteFirst: sameRuleSet && news.order === output.order,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile = output?.profile ?? olds?.profile;
      const ruleSet = output?.ruleSet ?? olds?.ruleSet;
      if (
        resourceGroup === undefined ||
        profile === undefined ||
        ruleSet === undefined
      ) {
        return undefined;
      }
      const name =
        output?.ruleName ?? olds?.name ?? (yield* createAlphanumericName(id));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        profile,
        ruleSet,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, ruleSet, name, observed);
      return (yield* profileOwnedByStack(
        subscriptionId,
        resourceGroup,
        profile,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile, ruleSet } = news;
      const name =
        news.name ?? output?.ruleName ?? (yield* createAlphanumericName(id));
      const properties = {
        order: news.order,
        conditions: news.conditions ?? [],
        actions: news.actions,
        matchProcessingBehavior: news.matchProcessingBehavior ?? "Continue",
      };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: profile,
        ruleSetName: ruleSet,
        ruleName: name,
      };
      const get = getRule(
        subscriptionId,
        resourceGroup,
        profile,
        ruleSet,
        name,
      );
      const label = `Front Door rule ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cdn
          .CreateRule({ ...where, properties })
          .pipe(Effect.retry(whileProfileBusy));
      }
      observed = yield* waitForAfd(
        label,
        get,
        (r) => r.properties?.provisioningState,
      );

      // Sync order, conditions, actions, and behavior against observed state.
      const changed = changedFields(properties, observed.properties);
      if (Object.keys(changed).length > 0) {
        yield* cdn
          .UpdateRule({ ...where, properties: changed })
          .pipe(Effect.retry(whileProfileBusy));
        observed = yield* waitForAfd(
          label,
          get,
          (r) => r.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, profile, ruleSet, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteRule({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profile,
            ruleSetName: output.ruleSet,
            ruleName: output.ruleName,
          })
          .pipe(Effect.retry(whileProfileBusy)),
      );
      yield* waitUntilGone(
        `Front Door rule ${output.ruleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.profile,
          output.ruleSet,
          output.ruleName,
        ),
        AFD_DELETE_BUDGET,
      );
    }),
  });
