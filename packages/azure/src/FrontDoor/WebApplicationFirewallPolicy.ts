import * as frontdoor from "@distilled.cloud/azure/frontdoor";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";

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
   * @default no managed rule sets
   */
  managedRules?: WebApplicationFirewallManagedRules;
  /**
   * User tags. Alchemy's ownership tags are merged in automatically.
   * @default {}
   */
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
 * An Azure Front Door Web Application Firewall (WAF) policy
 * (`Microsoft.Network/frontDoorWebApplicationFirewallPolicies`): custom
 * match and rate-limit rules plus managed rule sets that protect Front
 * Door Standard/Premium endpoints at the edge. Attach it to an endpoint
 * or custom domain with `Azure.Cdn.SecurityPolicy`.
 *
 * A new policy is enabled and in `Prevention` mode, so matching rules
 * block requests. The policy is global (`location` is `Global`). Alchemy
 * registers the `Microsoft.Network` resource provider for you, and every
 * deploy compares the live rules and settings with your props and sends
 * the whole policy when they differ.
 *
 * :::caution[Changing `name`, `sku`, or `resourceGroup` replaces the policy]
 * Alchemy creates a new policy, updates the `Azure.Cdn.SecurityPolicy`
 * that passes `waf.policyId` to use the new ID, and deletes the old
 * policy. With a fixed `name` that stays the same, Alchemy deletes the old
 * policy before it creates the new one.
 * :::
 *
 * :::caution[`sku` must match the profile's tier]
 * A `Standard_AzureFrontDoor` policy attaches only to a Standard profile,
 * and a `Premium_AzureFrontDoor` policy only to a Premium profile. Managed
 * rule sets, bot protection, JavaScript challenge, and CAPTCHA need
 * Premium.
 * :::
 *
 * @see https://learn.microsoft.com/azure/web-application-firewall/afds/afds-overview
 *
 * ### Creating a Policy
 * **Example:** Policy with no rules yet
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf");
 * ```
 *
 * **Example:** Detection-mode policy blocking an IP range
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
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
 * ### Custom Match Rules
 * Front Door evaluates custom rules in ascending `priority` order before
 * the managed rules. All `matchConditions` of a rule must match. Set
 * `negateCondition: true` to match when a condition does not.
 *
 * **Example:** Block requests from two countries
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   customRules: [
 *     {
 *       name: "GeoBlock",
 *       priority: 100,
 *       ruleType: "MatchRule",
 *       action: "Block",
 *       matchConditions: [
 *         { matchVariable: "RemoteAddr", operator: "GeoMatch", matchValue: ["KP", "IR"] },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Allow the admin path only from the office network
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   customRules: [
 *     {
 *       name: "AdminOfficeOnly",
 *       priority: 110,
 *       ruleType: "MatchRule",
 *       action: "Block",
 *       matchConditions: [
 *         { matchVariable: "RequestUri", operator: "BeginsWith", matchValue: ["/admin"] },
 *         {
 *           matchVariable: "RemoteAddr",
 *           operator: "IPMatch",
 *           negateCondition: true,
 *           matchValue: ["203.0.113.0/24"],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Block a user agent, case-insensitively
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   customRules: [
 *     {
 *       name: "BlockBadBot",
 *       priority: 120,
 *       ruleType: "MatchRule",
 *       action: "Block",
 *       matchConditions: [
 *         {
 *           matchVariable: "RequestHeader",
 *           selector: "User-Agent",
 *           operator: "Contains",
 *           transforms: ["Lowercase"],
 *           matchValue: ["badbot"],
 *         },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Rate Limiting
 * A `RateLimitRule` counts matching requests per `groupBy` key in a window
 * of `rateLimitDurationInMinutes` (1 or 5) and applies `action` once a
 * client passes `rateLimitThreshold`.
 *
 * **Example:** Rate limit requests per client IP
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
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
 * On a Premium policy, add Microsoft's managed rule sets: the Default Rule
 * Set blocks common attacks such as SQL injection and cross-site
 * scripting, and the Bot Manager rule set acts on known bots.
 *
 * **Example:** Premium policy with the default rule set
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
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
 * **Example:** Default rule set plus bot protection
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   sku: "Premium_AzureFrontDoor",
 *   managedRules: {
 *     managedRuleSets: [
 *       { ruleSetType: "Microsoft_DefaultRuleSet", ruleSetVersion: "2.1", ruleSetAction: "Block" },
 *       { ruleSetType: "Microsoft_BotManagerRuleSet", ruleSetVersion: "1.1" },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Tuning Managed Rules
 * Turn off a single rule that blocks legitimate traffic, or exclude a
 * request field from inspection, instead of turning off the rule set.
 *
 * **Example:** Disable one rule and exclude a cookie
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   sku: "Premium_AzureFrontDoor",
 *   managedRules: {
 *     managedRuleSets: [
 *       {
 *         ruleSetType: "Microsoft_DefaultRuleSet",
 *         ruleSetVersion: "2.1",
 *         ruleSetAction: "Block",
 *         exclusions: [
 *           { matchVariable: "RequestCookieNames", selectorMatchOperator: "Equals", selector: "session" },
 *         ],
 *         ruleGroupOverrides: [
 *           {
 *             ruleGroupName: "SQLI",
 *             rules: [{ ruleId: "942440", enabledState: "Disabled" }],
 *           },
 *         ],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Detection Mode
 * In `Detection` mode the policy logs matches and blocks nothing. Start a
 * new rule set there, check the logs, then switch to `Prevention`.
 *
 * **Example:** Switch a tuned policy to blocking
 * ```diff
 *  const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 * -  policySettings: { mode: "Detection" },
 * +  policySettings: { mode: "Prevention" },
 *  });
 * ```
 *
 * ### Block Responses and Redirects
 * Set the status code and body that blocked clients get, or send them to
 * a page with a `Redirect` action. `customBlockResponseBody` is base64.
 *
 * **Example:** Custom 403 body
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   policySettings: {
 *     mode: "Prevention",
 *     customBlockResponseStatusCode: 403,
 *     customBlockResponseBody: "QmxvY2tlZA==", // "Blocked"
 *   },
 * });
 * ```
 *
 * **Example:** Redirect blocked countries to a notice page
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   policySettings: { redirectUrl: "https://www.contoso.com/unavailable" },
 *   customRules: [
 *     {
 *       name: "GeoRedirect",
 *       priority: 100,
 *       ruleType: "MatchRule",
 *       action: "Redirect",
 *       matchConditions: [
 *         { matchVariable: "RemoteAddr", operator: "GeoMatch", matchValue: ["KP"] },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### JavaScript Challenge and CAPTCHA
 * On a Premium policy, a rule can challenge a client instead of blocking
 * it. The challenge cookie lives 5-1440 minutes (30 by default).
 *
 * **Example:** Challenge sign-in traffic
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   sku: "Premium_AzureFrontDoor",
 *   policySettings: { javascriptChallengeExpirationInMinutes: 60 },
 *   customRules: [
 *     {
 *       name: "ChallengeLogin",
 *       priority: 100,
 *       ruleType: "MatchRule",
 *       action: "JSChallenge",
 *       matchConditions: [
 *         { matchVariable: "RequestUri", operator: "BeginsWith", matchValue: ["/login"] },
 *       ],
 *     },
 *   ],
 * });
 * ```
 *
 * ### Log Scrubbing
 * Remove sensitive fields from the WAF logs.
 *
 * **Example:** Scrub client IPs and the authorization header
 * ```typescript
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   policySettings: {
 *     logScrubbing: {
 *       state: "Enabled",
 *       scrubbingRules: [
 *         { matchVariable: "RequestIPAddress", selectorMatchOperator: "EqualsAny" },
 *         {
 *           matchVariable: "RequestHeaderNames",
 *           selectorMatchOperator: "Equals",
 *           selector: "Authorization",
 *         },
 *       ],
 *     },
 *   },
 * });
 * ```
 *
 * ### Attaching to Front Door
 * `Azure.Cdn.SecurityPolicy` applies the policy to endpoints and custom
 * domains of one profile. The policy's `sku` must match the profile's.
 *
 * **Example:** Protect an endpoint
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("web", {
 *   profile: profile.profileName,
 * });
 * yield* Azure.Cdn.SecurityPolicy("waf", {
 *   profile: profile.profileName,
 *   wafPolicyId: waf.policyId,
 *   associations: [
 *     { domainIds: [endpoint.endpointId], patternsToMatch: ["/*"] },
 *   ],
 * });
 * ```
 *
 * **Example:** Premium profile and policy on a custom domain
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn", { sku: "Premium_AzureFrontDoor" });
 * const waf = yield* Azure.FrontDoor.WebApplicationFirewallPolicy("waf", {
 *   sku: "Premium_AzureFrontDoor",
 * });
 * const domain = yield* Azure.Cdn.AfdCustomDomain("www", {
 *   profile: profile.profileName,
 *   hostName: "www.contoso.com",
 * });
 * yield* Azure.Cdn.SecurityPolicy("waf", {
 *   profile: profile.profileName,
 *   wafPolicyId: waf.policyId,
 *   associations: [{ domainIds: [domain.customDomainId] }],
 * });
 * ```
 *
 * @resource
 */
export const WebApplicationFirewallPolicy = GroupedResource<WebApplicationFirewallPolicy>(
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

const getPolicy = (subscriptionId: string, resourceGroupName: string, policyName: string) =>
  orUndefinedIfNotFound(frontdoor.GetPolicy({ subscriptionId, resourceGroupName, policyName }));

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
  securityPolicyLinks: (policy.properties?.securityPolicyLinks ?? []).flatMap((link) =>
    link.id ? [link.id] : [],
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
  !covers(observed?.managedRules?.managedRuleSets ?? [], desired.managedRules?.managedRuleSets) ||
  !covers(observed?.managedRules?.exceptionsList, desired.managedRules?.exceptionsList);

export const WebApplicationFirewallPolicyProvider = () =>
  Provider.succeed(WebApplicationFirewallPolicy, {
    stables: ["policyName", "resourceGroup", "policyId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(frontdoor.ListPolicyBySubscription, { subscriptionId });
      return (page.value ?? []).flatMap((policy) => {
        const group = resourceGroupOf(policy.id);
        return hasAnyAlchemyTag(policy.tags) && group !== undefined && policy.name !== undefined
          ? [toAttrs(group, policy.name, policy)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const name = news.name ?? output.policyName;
      const sku = news.sku ?? DEFAULT_SKU;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        name.toLowerCase() !== output.policyName.toLowerCase() ||
        sku.toLowerCase() !== output.sku.toLowerCase()
      ) {
        // A pinned name that stays the same can only be replaced by
        // deleting the old policy first.
        const sameName =
          news.name !== undefined &&
          news.resourceGroup.toLowerCase() === output.resourceGroup.toLowerCase() &&
          name.toLowerCase() === output.policyName.toLowerCase();
        return { action: "replace", deleteFirst: sameName } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.policyName ?? olds?.name ?? (yield* physicalName(id));
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
