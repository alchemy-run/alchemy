import * as frontdoor from "@distilled.cloud/azure/frontdoor";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

/** Pricing tier of a Front Door WAF policy. */
export type WebApplicationFirewallPolicySku =
  | "Standard_AzureFrontDoor"
  | "Premium_AzureFrontDoor"
  | "Classic_AzureFrontDoor";

/** Policy-wide WAF settings. */
export type WebApplicationFirewallPolicySettings = frontdoor.PolicySettings;

/** A custom WAF rule (match or rate-limit rule). */
export type WebApplicationFirewallCustomRule = frontdoor.CustomRule;

/** Managed rule sets and exceptions applied by a WAF policy. */
export type WebApplicationFirewallManagedRules = frontdoor.ManagedRuleSetList;

export interface WebApplicationFirewallPolicyProps {
  /**
   * Resource group the policy is created in. Front Door rejects resource
   * group names longer than 80 characters. Changing it replaces the policy.
   */
  resourceGroup: string;
  /**
   * Name of the policy: letters and digits only, starting with a letter,
   * at most 128 characters. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Pricing tier. Must match the tier of the Front Door profile the policy
   * is attached to; managed rule sets, bot protection, JavaScript
   * challenge and CAPTCHA require `Premium_AzureFrontDoor`. Changing it
   * replaces the policy.
   * @default "Standard_AzureFrontDoor"
   */
  sku?: WebApplicationFirewallPolicySku;
  /**
   * Policy-wide settings: enabled state, `Detection`/`Prevention` mode,
   * custom block response, redirect URL, request-body inspection, log
   * scrubbing, and challenge cookie lifetimes.
   * @default { enabledState: "Enabled", mode: "Prevention" }
   */
  policySettings?: WebApplicationFirewallPolicySettings;
  /**
   * Custom rules evaluated in ascending `priority` order before the managed
   * rules.
   * @default []
   */
  customRules?: WebApplicationFirewallCustomRule[];
  /**
   * Managed rule sets (e.g. `Microsoft_DefaultRuleSet` 2.1,
   * `Microsoft_BotManagerRuleSet` 1.1) and exceptions. Premium only.
   */
  managedRules?: WebApplicationFirewallManagedRules;
  /** User tags. Alchemy's ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface WebApplicationFirewallPolicy extends Resource<
  "Azure.FrontDoor.WebApplicationFirewallPolicy",
  WebApplicationFirewallPolicyProps,
  {
    /** Name of the policy. */
    policyName: string;
    /** Resource group that holds the policy. */
    resourceGroup: string;
    /**
     * ARM resource ID of the policy, e.g. for
     * `Azure.Cdn.SecurityPolicy.wafPolicyId`.
     */
    policyId: string;
    /** Pricing tier of the policy. */
    sku: string;
    /** Whether the policy is `Enabled` or `Disabled`. */
    enabledState: string | undefined;
    /** `Detection` or `Prevention`. */
    mode: string | undefined;
    /** Resource state of the policy (e.g. `Enabled`). */
    resourceState: string | undefined;
    /** Provisioning state of the policy. */
    provisioningState: string | undefined;
    /** ARM IDs of the Front Door security policies using this policy. */
    securityPolicyLinks: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Front Door Web Application Firewall (WAF) policy — custom
 * match/rate-limit rules and managed rule sets that protect Front Door
 * Standard/Premium endpoints. Attach it to an endpoint or custom domain with
 * `Azure.Cdn.SecurityPolicy`.
 *
 * @see https://learn.microsoft.com/azure/web-application-firewall/afds/afds-overview
 *
 * ### Creating a Policy
 * **Example:** Detection-mode policy blocking an IP range
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("edge");
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   resourceGroup: group.resourceGroupName,
 *   policySettings: { enabledState: "Enabled", mode: "Detection" },
 *   customRules: [
 *     {
 *       name: "BlockTestNet",
 *       priority: 100,
 *       ruleType: "MatchRule",
 *       action: "Block",
 *       matchConditions: [
 *         {
 *           matchVariable: "RemoteAddr",
 *           operator: "IPMatch",
 *           matchValue: ["192.0.2.0/24"],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Rate limit requests per client IP
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   resourceGroup: group.resourceGroupName,
 *   customRules: [
 *     {
 *       name: "RateLimit",
 *       priority: 200,
 *       ruleType: "RateLimitRule",
 *       rateLimitDurationInMinutes: 1,
 *       rateLimitThreshold: 500,
 *       groupBy: [{ variableName: "SocketAddr" }],
 *       action: "Block",
 *       matchConditions: [
 *         { matchVariable: "RequestUri", operator: "Contains", matchValue: ["/api"] },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Managed Rule Sets
 * **Example:** Premium policy with the default rule set
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium_AzureFrontDoor",
 *   managedRules: {
 *     managedRuleSets: [
 *       {
 *         ruleSetType: "Microsoft_DefaultRuleSet",
 *         ruleSetVersion: "2.1",
 *         ruleSetAction: "Block",
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Attaching to Front Door
 * **Example:** Protect an endpoint
 * ```typescript
 * yield* Azure.Cdn.SecurityPolicy("waf", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   wafPolicyId: waf.policyId,
 *   associations: [
 *     { domainIds: [endpoint.endpointId], patternsToMatch: ["/*"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const WebApplicationFirewallPolicy =
  Resource<WebApplicationFirewallPolicy>(
    "Azure.FrontDoor.WebApplicationFirewallPolicy",
  );

type ObservedPolicy = frontdoor.GetPolicyResponse;

const DEFAULT_SKU: WebApplicationFirewallPolicySku = "Standard_AzureFrontDoor";

const physicalName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 128,
    delimiter: "",
  });
  const clean = name.replace(/[^a-zA-Z0-9]/g, "");
  return /^[a-zA-Z]/.test(clean) ? clean : `w${clean}`.slice(0, 128);
});

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  policyName: string,
) =>
  orUndefinedIfNotFound(
    frontdoor.GetPolicy({ subscriptionId, resourceGroupName, policyName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  policy: ObservedPolicy,
): WebApplicationFirewallPolicy["Attributes"] => ({
  policyName: name,
  resourceGroup,
  policyId: policy.id ?? "",
  sku: policy.sku?.name ?? "",
  enabledState: policy.properties?.policySettings?.enabledState,
  mode: policy.properties?.policySettings?.mode,
  resourceState: policy.properties?.resourceState,
  provisioningState: policy.properties?.provisioningState,
  securityPolicyLinks: (policy.properties?.securityPolicyLinks ?? []).flatMap(
    (link) => (link.id ? [link.id] : []),
  ),
  tags: userTags(policy.tags),
});

/**
 * Whether every value set in `desired` is present in `observed`. Azure
 * fills defaults (e.g. `negateCondition: false`, `transforms: []`), so the
 * observed body is a superset of what was sent. Arrays must match in
 * length; strings compare case-insensitively (ARM normalizes enum casing).
 */
const covers = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined || desired === null) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((item, i) => covers(observed[i], item))
    );
  }
  if (typeof desired === "object") {
    if (typeof observed !== "object" || observed === null) return false;
    return Object.entries(desired).every(([key, value]) =>
      covers((observed as Record<string, unknown>)[key], value),
    );
  }
  if (typeof desired === "string" && typeof observed === "string") {
    return desired.toLowerCase() === observed.toLowerCase();
  }
  return desired === observed;
};

const desiredProperties = (
  news: WebApplicationFirewallPolicyProps,
): frontdoor.WebApplicationFirewallPolicyPropertiesInput => ({
  policySettings: {
    enabledState: "Enabled",
    mode: "Prevention",
    ...news.policySettings,
  },
  customRules: { rules: news.customRules ?? [] },
  managedRules: {
    ...news.managedRules,
    managedRuleSets: news.managedRules?.managedRuleSets ?? [],
  },
});

const propertiesDrift = (
  observed: frontdoor.WebApplicationFirewallPolicyProperties | undefined,
  desired: frontdoor.WebApplicationFirewallPolicyPropertiesInput,
) =>
  !covers(observed?.policySettings, desired.policySettings) ||
  !covers(observed?.customRules?.rules ?? [], desired.customRules?.rules) ||
  !covers(
    observed?.managedRules?.managedRuleSets ?? [],
    desired.managedRules?.managedRuleSets,
  ) ||
  !covers(
    observed?.managedRules?.exceptionsList,
    desired.managedRules?.exceptionsList,
  );

export const WebApplicationFirewallPolicyProvider = () =>
  Provider.succeed(WebApplicationFirewallPolicy, {
    stables: ["policyName", "resourceGroup", "policyId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* frontdoor
        .ListPolicyBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPolicyBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((policy) => {
        const group = resourceGroupOf(policy.id);
        return hasAnyAlchemyTag(policy.tags) &&
          group !== undefined &&
          policy.name !== undefined
          ? [toAttrs(group, policy.name, policy)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const name = news.name ?? output.policyName;
      const sku = news.sku ?? DEFAULT_SKU;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        name.toLowerCase() !== output.policyName.toLowerCase() ||
        sku.toLowerCase() !== output.sku.toLowerCase()
      ) {
        // A pinned name that stays the same can only be replaced by
        // deleting the old policy first.
        const sameName =
          news.name !== undefined &&
          news.resourceGroup.toLowerCase() ===
            output.resourceGroup.toLowerCase() &&
          name.toLowerCase() === output.policyName.toLowerCase();
        return { action: "replace", deleteFirst: sameName } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.policyName ?? olds?.name ?? (yield* physicalName(id));
      const observed = yield* getPolicy(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return isOwned(id, observed.tags) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.policyName ?? (yield* physicalName(id));
      const sku = news.sku ?? DEFAULT_SKU;
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredProperties(news);
      const request = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        policyName: name,
      };
      const get = getPolicy(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `front door waf policy ${name}`,
        get,
        (policy) => policy.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure + sync the policy body: the PUT is a full upsert, so send it
      // when the policy is missing or its observed rules/settings drift.
      if (
        observed === undefined ||
        (observed.sku?.name ?? "").toLowerCase() !== sku.toLowerCase() ||
        propertiesDrift(observed.properties, properties)
      ) {
        yield* frontdoor.PoliciesCreateOrUpdate({
          ...request,
          location: "Global",
          sku: { name: sku },
          tags,
          properties,
        });
        observed = yield* settle;
      }

      // Sync tags against observed tags (PATCH is tags-only).
      if (tagsDiffer(observed.tags, tags)) {
        yield* frontdoor.UpdatePolicy({ ...request, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        frontdoor.DeletePolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          policyName: output.policyName,
        }),
      );
      yield* waitUntilGone(
        `front door waf policy ${output.policyName}`,
        getPolicy(subscriptionId, output.resourceGroup, output.policyName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
