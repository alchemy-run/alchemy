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
  createAfdName,
  matchesDesired,
  profileOwnedByStack,
  sameName,
  waitForAfd,
  whileProfileBusy,
} from "./CdnCommon.ts";

export interface SecurityPolicyAssociation {
  /**
   * ARM IDs of the endpoints (`AfdEndpoint.endpointId`) and custom domains
   * (`AfdCustomDomain.customDomainId`) the WAF policy protects.
   */
  domainIds: string[];
  /** Path patterns the policy applies to. @default ["/*"] */
  patternsToMatch?: string[];
}

export interface SecurityPolicyProps {
  /** Resource group of the profile. Changing it replaces the security policy. */
  resourceGroup: string;
  /** Front Door profile that holds the policy. Changing it replaces the security policy. */
  profile: string;
  /**
   * Security policy name: letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the security policy.
   */
  name?: string;
  /**
   * ARM ID of the Front Door WAF policy
   * (`Microsoft.Network/frontDoorWebApplicationFirewallPolicies`).
   */
  wafPolicyId: string;
  /** Domains and paths the WAF policy is applied to. */
  associations: SecurityPolicyAssociation[];
}

export interface SecurityPolicy extends Resource<
  "Azure.Cdn.SecurityPolicy",
  SecurityPolicyProps,
  {
    /** Name of the security policy. */
    securityPolicyName: string;
    /** ARM resource ID of the security policy. */
    securityPolicyId: string;
    /** Front Door profile that holds the policy. */
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
 * A Front Door security policy — attaches a Web Application Firewall policy
 * to endpoints and custom domains.
 *
 * @see https://learn.microsoft.com/azure/frontdoor/web-application-firewall
 *
 * ### Attaching a WAF Policy
 * **Example:** Protect an endpoint with a WAF policy
 * ```typescript
 * const policy = yield* Azure.Cdn.SecurityPolicy("waf", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   wafPolicyId: wafPolicy.id,
 *   associations: [
 *     { domainIds: [endpoint.endpointId], patternsToMatch: ["/*"] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const SecurityPolicy = Resource<SecurityPolicy>(
  "Azure.Cdn.SecurityPolicy",
);

const createPolicyName = (id: string) => createAfdName(id, 50);

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  securityPolicyName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetSecurityPolicy({
      subscriptionId,
      resourceGroupName,
      profileName,
      securityPolicyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  name: string,
  policy: cdn.GetSecurityPolicyResponse,
): SecurityPolicy["Attributes"] => ({
  securityPolicyName: name,
  securityPolicyId: policy.id ?? "",
  profile,
  resourceGroup,
  deploymentStatus: policy.properties?.deploymentStatus,
});

const toParameters = (news: SecurityPolicyProps) => ({
  type: "WebApplicationFirewall",
  wafPolicy: { id: news.wafPolicyId },
  associations: news.associations.map((association) => ({
    domains: association.domainIds.map((id) => ({ id })),
    patternsToMatch: association.patternsToMatch ?? ["/*"],
  })),
});

export const SecurityPolicyProvider = () =>
  Provider.succeed(SecurityPolicy, {
    stables: [
      "securityPolicyName",
      "securityPolicyId",
      "profile",
      "resourceGroup",
    ],

    // Security policies are deleted with their profile.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.profile, output.profile) ||
        (news.name !== undefined &&
          !sameName(news.name, output.securityPolicyName))
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
        output?.securityPolicyName ??
        olds?.name ??
        (yield* createPolicyName(id));
      const observed = yield* getPolicy(
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

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile } = news;
      const name =
        news.name ??
        output?.securityPolicyName ??
        (yield* createPolicyName(id));
      const parameters = toParameters(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: profile,
        securityPolicyName: name,
      };
      const get = getPolicy(subscriptionId, resourceGroup, profile, name);
      const label = `Front Door security policy ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cdn
          .CreateSecurityPolicy({ ...where, properties: { parameters } })
          .pipe(Effect.retry(whileProfileBusy));
      }
      observed = yield* waitForAfd(
        label,
        get,
        (p) => p.properties?.provisioningState,
      );

      // Sync the WAF policy and associations against observed state.
      if (!matchesDesired(parameters, observed.properties?.parameters)) {
        yield* cdn
          .PatchSecurityPolicy({ ...where, properties: { parameters } })
          .pipe(Effect.retry(whileProfileBusy));
        observed = yield* waitForAfd(
          label,
          get,
          (p) => p.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, profile, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteSecurityPolicy({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profile,
            securityPolicyName: output.securityPolicyName,
          })
          .pipe(Effect.retry(whileProfileBusy)),
      );
      yield* waitUntilGone(
        `Front Door security policy ${output.securityPolicyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.profile,
          output.securityPolicyName,
        ),
        AFD_DELETE_BUDGET,
      );
    }),
  });
