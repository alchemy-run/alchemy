import * as dnsresolver from "@distilled.cloud/azure/dnsresolver";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createDnsResolverName,
  FAST_BUDGET,
  sameArm,
  sameArmIds,
} from "./Common.ts";

/** What a DNS security rule does with matching queries. */
export type SecurityRuleAction = "Allow" | "Alert" | "Block";

export interface SecurityRuleProps {
  /**
   * Resource group of the DNS security policy. The DNS resolver API rejects
   * resource group names longer than 80 characters. Changing it replaces
   * the rule.
   */
  resourceGroup: string;
  /**
   * Name of the DNS security policy the rule belongs to. Changing it
   * replaces the rule.
   */
  dnsResolverPolicy: string;
  /**
   * Rule name: 1-80 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the rule.
   */
  name?: string;
  /**
   * Azure location of the rule; must match the policy. Changing it
   * replaces the rule.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Rule priority, 100-65000. Lower values are evaluated first; priorities
   * must be unique within a policy.
   */
  priority: number;
  /** Action taken on DNS queries that match one of the domain lists. */
  action: SecurityRuleAction;
  /** ARM IDs of the DNS resolver domain lists the rule matches against. */
  domainListIds: string[];
  /**
   * Whether the rule is evaluated.
   * @default "Enabled"
   */
  state?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SecurityRule extends Resource<
  "Azure.DnsResolver.SecurityRule",
  SecurityRuleProps,
  {
    /** Name of the rule. */
    securityRuleName: string;
    /** ARM resource ID of the rule. */
    securityRuleId: string;
    /** Name of the DNS security policy that holds the rule. */
    dnsResolverPolicy: string;
    /** Resource group of the policy. */
    resourceGroup: string;
    /** Location of the rule. */
    location: string;
    /** Rule priority. */
    priority: number;
    /** Action taken on matching queries. */
    action: string | undefined;
    /** ARM IDs of the matched domain lists. */
    domainListIds: string[];
    /** Whether the rule is evaluated (`Enabled` or `Disabled`). */
    state: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure DNS security rule — allows, alerts on, or blocks DNS queries
 * for the domains in one or more domain lists, for every virtual network
 * linked to its DNS security policy.
 *
 * @see https://learn.microsoft.com/azure/dns/dns-security-policy
 *
 * ### Creating a Rule
 * **Example:** Block a list of domains
 * ```typescript
 * const blocked = yield* Azure.DnsResolver.DomainList("blocked", {
 *   resourceGroup: group.resourceGroupName,
 *   domains: ["malicious.example.com."],
 * });
 * const policy = yield* Azure.DnsResolver.Policy("dns-security", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const rule = yield* Azure.DnsResolver.SecurityRule("block-bad", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsResolverPolicy: policy.policyName,
 *   priority: 100,
 *   action: "Block",
 *   domainListIds: [blocked.domainListId],
 * });
 * ```
 *
 * ### Updating a Rule
 * **Example:** Alert instead of block, temporarily disabled
 * ```typescript
 * const rule = yield* Azure.DnsResolver.SecurityRule("block-bad", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsResolverPolicy: policy.policyName,
 *   priority: 200,
 *   action: "Alert",
 *   domainListIds: [blocked.domainListId],
 *   state: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const SecurityRule = Resource<SecurityRule>(
  "Azure.DnsResolver.SecurityRule",
);

const getRule = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsResolverPolicyName: string,
  dnsSecurityRuleName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetDnsSecurityRule({
      subscriptionId,
      resourceGroupName,
      dnsResolverPolicyName,
      dnsSecurityRuleName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  policyName: string,
  name: string,
  rule: dnsresolver.GetDnsSecurityRuleResponse | dnsresolver.DnsSecurityRule,
): SecurityRule["Attributes"] => ({
  securityRuleName: name,
  securityRuleId: rule.id ?? "",
  dnsResolverPolicy: policyName,
  resourceGroup,
  location: rule.location,
  priority: rule.properties.priority,
  action: rule.properties.action.actionType,
  domainListIds: rule.properties.dnsResolverDomainLists.map((list) => list.id),
  state: rule.properties.dnsSecurityRuleState,
  tags: userTags(rule.tags),
});

type Observed =
  | dnsresolver.GetDnsSecurityRuleResponse
  | dnsresolver.DnsSecurityRule;

/** The rule properties that differ between observed and desired state. */
const propertiesDelta = (observed: Observed, news: SecurityRuleProps) => {
  const desiredState = news.state ?? "Enabled";
  const props = observed.properties;
  const delta: dnsresolver.DnsSecurityRulePatchProperties = {};
  if (props.priority !== news.priority) delta.priority = news.priority;
  if (props.action.actionType !== news.action) {
    delta.action = { actionType: news.action };
  }
  if (
    !sameArmIds(
      props.dnsResolverDomainLists.map((list) => list.id),
      news.domainListIds,
    )
  ) {
    delta.dnsResolverDomainLists = news.domainListIds.map((id) => ({ id }));
  }
  if ((props.dnsSecurityRuleState ?? "Enabled") !== desiredState) {
    delta.dnsSecurityRuleState = desiredState;
  }
  return Object.keys(delta).length > 0 ? delta : undefined;
};

export const SecurityRuleProvider = () =>
  Provider.succeed(SecurityRule, {
    stables: [
      "securityRuleName",
      "securityRuleId",
      "dnsResolverPolicy",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const policies = yield* dnsresolver
        .ListDnsResolverPolicies({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDnsResolverPolicies", page),
          ),
        );
      const found: SecurityRule["Attributes"][] = [];
      for (const policy of policies.value ?? []) {
        const group = resourceGroupOf(policy.id);
        if (group === undefined || policy.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          dnsresolver.ListDnsSecurityRules({
            subscriptionId,
            resourceGroupName: group,
            dnsResolverPolicyName: policy.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListDnsSecurityRules", page);
        }
        for (const rule of page?.value ?? []) {
          if (hasAnyAlchemyTag(rule.tags) && rule.name !== undefined) {
            found.push(toAttrs(group, policy.name, rule.name, rule));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const samePolicy =
        sameArm(news.resourceGroup, output.resourceGroup) &&
        sameArm(news.dnsResolverPolicy, output.dnsResolverPolicy);
      if (
        !samePolicy ||
        (news.name !== undefined && news.name !== output.securityRuleName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        // Priorities are unique within a policy: a replacement in the same
        // policy at the same priority fails to provision until the old
        // rule is gone.
        return {
          action: "replace",
          deleteFirst: samePolicy && news.priority === output.priority,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const policyName = output?.dnsResolverPolicy ?? olds?.dnsResolverPolicy;
      if (resourceGroup === undefined || policyName === undefined) {
        return undefined;
      }
      const name =
        output?.securityRuleName ??
        olds?.name ??
        (yield* createDnsResolverName(id));
      const observed = yield* getRule(
        subscriptionId,
        resourceGroup,
        policyName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, policyName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, dnsResolverPolicy: policyName } = news;
      const name =
        news.name ??
        output?.securityRuleName ??
        (yield* createDnsResolverName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsResolverPolicyName: policyName,
        dnsSecurityRuleName: name,
      };
      const get = getRule(subscriptionId, resourceGroup, policyName, name);
      const label = `DNS security rule ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* dnsresolver.DnsSecurityRulesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            priority: news.priority,
            action: { actionType: news.action },
            dnsResolverDomainLists: news.domainListIds.map((id) => ({ id })),
            dnsSecurityRuleState: news.state ?? "Enabled",
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (rule) => rule.properties.provisioningState,
        FAST_BUDGET,
      );

      // Sync rule properties and tags against observed state.
      const delta = propertiesDelta(observed, news);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || tagsChanged) {
        yield* dnsresolver.UpdateDnsSecurityRule({
          ...where,
          properties: delta,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (rule) =>
            tagsDiffer(rule.tags, tags) ||
            propertiesDelta(rule, news) !== undefined
              ? "Updating"
              : rule.properties.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, policyName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver.DeleteDnsSecurityRule({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          dnsResolverPolicyName: output.dnsResolverPolicy,
          dnsSecurityRuleName: output.securityRuleName,
        }),
      );
      yield* waitUntilGone(
        `DNS security rule ${output.securityRuleName}`,
        getRule(
          subscriptionId,
          output.resourceGroup,
          output.dnsResolverPolicy,
          output.securityRuleName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DnsResolver.Policy",
        "Azure.DnsResolver.DomainList",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
