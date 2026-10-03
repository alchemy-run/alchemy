import * as servicenetworking from "@distilled.cloud/azure/servicenetworking";
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
import { AGC_BUDGET, childLocation, createAgcName, sameArm } from "./Common.ts";

export interface SecurityPolicyIpAccessRule {
  /** Name of the rule, unique within the policy. */
  name: string;
  /**
   * Priority between 1 and 500, unique within the policy. Lower numbers
   * are evaluated first.
   */
  priority: number;
  /** Source CIDR ranges the rule matches; `*` matches every source IP. */
  sourceAddressPrefixes: string[];
  /** Whether matching requests are allowed or denied. */
  action: "allow" | "deny";
}

export interface SecurityPolicyProps {
  /**
   * Resource group of the traffic controller. Changing it replaces the
   * policy.
   */
  resourceGroup: string;
  /**
   * Name of the traffic controller that owns the policy. Changing it
   * replaces the policy.
   */
  trafficController: string;
  /**
   * Policy name: up to 64 letters, digits, `-`, `_`, and `.`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the policy.
   */
  name?: string;
  /**
   * Azure location of the policy; must match the traffic controller's
   * location. Changing it replaces the policy.
   * @default the traffic controller's location
   */
  location?: string;
  /**
   * ARM ID of an Application Gateway WAF policy
   * (`Microsoft.Network/ApplicationGatewayWebApplicationFirewallPolicies`)
   * — makes this a `waf` policy. Set exactly one of `wafPolicyId` and
   * `ipAccessRules`; switching between the two replaces the policy.
   */
  wafPolicyId?: string;
  /**
   * IP access rules — makes this an `ipAccessRules` policy. Set exactly one
   * of `wafPolicyId` and `ipAccessRules`; the rules are updated in place.
   */
  ipAccessRules?: SecurityPolicyIpAccessRule[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SecurityPolicy extends Resource<
  "Azure.ServiceNetworking.SecurityPolicy",
  SecurityPolicyProps,
  {
    /** Name of the policy. */
    securityPolicyName: string;
    /**
     * ARM resource ID of the policy; reference it from a frontend's or the
     * traffic controller's security policy configurations.
     */
    securityPolicyId: string;
    /** Name of the traffic controller that owns the policy. */
    trafficController: string;
    /** Resource group of the traffic controller. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** Policy type: `waf` or `ipAccessRules`. */
    policyType: string | undefined;
    /** ARM ID of the referenced WAF policy (`waf` policies). */
    wafPolicyId: string | undefined;
    /** Observed IP access rules (`ipAccessRules` policies). */
    ipAccessRules: SecurityPolicyIpAccessRule[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A security policy of an Application Gateway for Containers traffic
 * controller — either a Web Application Firewall policy reference or a list
 * of IP access rules. Attach it to individual frontends or to the whole
 * traffic controller through `securityPolicyConfigurations`.
 *
 * IP access rule policies are free; WAF policies bill extra per frontend.
 *
 * @see https://learn.microsoft.com/azure/application-gateway/for-containers/ip-access-restriction
 *
 * ### IP Access Rules
 * **Example:** Allow one range, deny everything else
 * ```typescript
 * const policy = yield* Azure.ServiceNetworking.SecurityPolicy("ip-rules", {
 *   resourceGroup: group.resourceGroupName,
 *   trafficController: controller.trafficControllerName,
 *   ipAccessRules: [
 *     {
 *       name: "office",
 *       priority: 100,
 *       sourceAddressPrefixes: ["203.0.113.0/24"],
 *       action: "allow",
 *     },
 *     {
 *       name: "everyone-else",
 *       priority: 500,
 *       sourceAddressPrefixes: ["*"],
 *       action: "deny",
 *     },
 *   ],
 * });
 * ```
 *
 * ### Web Application Firewall
 * **Example:** Reference an Application Gateway WAF policy
 * ```typescript
 * const waf = yield* Azure.Network.WebApplicationFirewallPolicy("waf", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const policy = yield* Azure.ServiceNetworking.SecurityPolicy("waf", {
 *   resourceGroup: group.resourceGroupName,
 *   trafficController: controller.trafficControllerName,
 *   wafPolicyId: waf.policyId,
 * });
 * ```
 *
 * @resource
 */
export const SecurityPolicy = Resource<SecurityPolicy>(
  "Azure.ServiceNetworking.SecurityPolicy",
);

type Observed =
  | servicenetworking.GetSecurityPoliciesInterfaceResponse
  | servicenetworking.SecurityPolicy;

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  trafficControllerName: string,
  securityPolicyName: string,
) =>
  orUndefinedIfNotFound(
    servicenetworking.GetSecurityPoliciesInterface({
      subscriptionId,
      resourceGroupName,
      trafficControllerName,
      securityPolicyName,
    }),
  );

const toRules = (
  rules: ReadonlyArray<servicenetworking.IpAccessRule> | undefined,
): SecurityPolicyIpAccessRule[] =>
  (rules ?? []).map((rule) => ({
    name: rule.name,
    priority: rule.priority,
    sourceAddressPrefixes: [...rule.sourceAddressPrefixes],
    action: rule.action === "deny" ? "deny" : "allow",
  }));

const toAttrs = (
  resourceGroup: string,
  trafficController: string,
  name: string,
  policy: Observed,
): SecurityPolicy["Attributes"] => ({
  securityPolicyName: name,
  securityPolicyId: policy.id ?? "",
  trafficController,
  resourceGroup,
  location: policy.location,
  policyType: policy.properties?.policyType,
  wafPolicyId: policy.properties?.wafPolicy?.id,
  ipAccessRules: toRules(policy.properties?.ipAccessRulesPolicy?.rules),
  tags: userTags(policy.tags),
});

/** Order-insensitive comparison of rule lists (rules are keyed by name). */
const canonicalRules = (rules: ReadonlyArray<SecurityPolicyIpAccessRule>) =>
  JSON.stringify(
    [...rules]
      .map((rule) => ({
        name: rule.name,
        priority: rule.priority,
        action: rule.action.toLowerCase(),
        sourceAddressPrefixes: [...rule.sourceAddressPrefixes].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

const policyTypeOf = (props: {
  wafPolicyId?: string;
  ipAccessRules?: unknown;
}) => (props.wafPolicyId !== undefined ? "waf" : "ipAccessRules");

export const SecurityPolicyProvider = () =>
  Provider.succeed(SecurityPolicy, {
    stables: [
      "securityPolicyName",
      "securityPolicyId",
      "trafficController",
      "resourceGroup",
      "location",
      "policyType",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const controllers = yield* servicenetworking
        .ListTrafficControllerInterfaceBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListTrafficControllerInterfaceBySubscription",
              page,
            ),
          ),
        );
      const found: SecurityPolicy["Attributes"][] = [];
      for (const controller of controllers.value ?? []) {
        const group = resourceGroupOf(controller.id);
        if (group === undefined || controller.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          servicenetworking.ListSecurityPoliciesInterfaceByTrafficController({
            subscriptionId,
            resourceGroupName: group,
            trafficControllerName: controller.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage(
            "ListSecurityPoliciesInterfaceByTrafficController",
            page,
          );
        }
        for (const policy of page?.value ?? []) {
          if (hasAnyAlchemyTag(policy.tags) && policy.name !== undefined) {
            found.push(toAttrs(group, controller.name, policy.name, policy));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.trafficController, output.trafficController) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.securityPolicyName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (output.policyType !== undefined &&
          !sameArm(policyTypeOf(news), output.policyType))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const trafficController =
        output?.trafficController ?? olds?.trafficController;
      if (resourceGroup === undefined || trafficController === undefined) {
        return undefined;
      }
      const name =
        output?.securityPolicyName ?? olds?.name ?? (yield* createAgcName(id));
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        trafficController,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, trafficController, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceNetworking");
      const { resourceGroup, trafficController } = news;
      const name =
        news.name ?? output?.securityPolicyName ?? (yield* createAgcName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        trafficControllerName: trafficController,
        securityPolicyName: name,
      };
      const get = getPolicy(
        subscriptionId,
        resourceGroup,
        trafficController,
        name,
      );
      const label = `AGC security policy ${name}`;
      const desiredRules = news.ipAccessRules ?? [];
      const ipAccessRulesPolicy = {
        rules: desiredRules.map((rule) => ({
          name: rule.name,
          priority: rule.priority,
          sourceAddressPrefixes: [...rule.sourceAddressPrefixes],
          action: rule.action,
        })),
      };

      // Observe.
      let observed = yield* get;

      // Ensure (long-running PUT). Children live in the parent's location.
      if (observed === undefined) {
        const location = yield* childLocation(
          subscriptionId,
          resourceGroup,
          trafficController,
          news.location ?? output?.location,
          env.location,
        );
        yield* servicenetworking.SecurityPoliciesInterfaceCreateOrUpdate({
          ...where,
          location,
          tags,
          properties:
            news.wafPolicyId !== undefined
              ? { wafPolicy: { id: news.wafPolicyId } }
              : { ipAccessRulesPolicy },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (policy) => policy.properties?.provisioningState,
        AGC_BUDGET,
      );

      // Sync tags and policy content against observed state.
      const tagsChanged = tagsDiffer(observed.tags, tags);
      const wafChanged =
        news.wafPolicyId !== undefined &&
        !sameArm(news.wafPolicyId, observed.properties?.wafPolicy?.id);
      const rulesChanged =
        news.wafPolicyId === undefined &&
        canonicalRules(desiredRules) !==
          canonicalRules(
            toRules(observed.properties?.ipAccessRulesPolicy?.rules),
          );
      if (tagsChanged || wafChanged || rulesChanged) {
        yield* servicenetworking.UpdateSecurityPoliciesInterface({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: wafChanged
            ? { wafPolicy: { id: news.wafPolicyId } }
            : rulesChanged
              ? { ipAccessRulesPolicy }
              : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (policy) =>
            tagsDiffer(policy.tags, tags)
              ? "Updating"
              : policy.properties?.provisioningState,
          AGC_BUDGET,
        );
      }

      return toAttrs(resourceGroup, trafficController, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        servicenetworking.DeleteSecurityPoliciesInterface({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          trafficControllerName: output.trafficController,
          securityPolicyName: output.securityPolicyName,
        }),
      );
      yield* waitUntilGone(
        `AGC security policy ${output.securityPolicyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.trafficController,
          output.securityPolicyName,
        ),
        AGC_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.ServiceNetworking.TrafficController",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
