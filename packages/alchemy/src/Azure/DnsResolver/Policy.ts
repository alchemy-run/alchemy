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
  whileNestedResourcesExist,
} from "./Common.ts";

export interface PolicyProps {
  /**
   * Resource group the policy is created in. The DNS resolver API rejects resource group names
   * longer than 80 characters. Changing it replaces the policy.
   */
  resourceGroup: string;
  /**
   * Policy name: 1-80 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the policy.
   */
  name?: string;
  /**
   * Azure location of the policy; must match the virtual networks linked
   * to it. Changing it replaces the policy.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Policy extends Resource<
  "Azure.DnsResolver.Policy",
  PolicyProps,
  {
    /** Name of the policy. */
    policyName: string;
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Resource group that holds the policy. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** Immutable GUID Azure assigns to the policy. */
    resourceGuid: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure DNS security policy (DNS resolver policy) — filters and logs
 * DNS queries from the virtual networks linked to it, using DNS security
 * rules over domain lists.
 *
 * @see https://learn.microsoft.com/azure/dns/dns-security-policy
 *
 * ### Creating a Policy
 * **Example:** DNS security policy
 * ```typescript
 * const policy = yield* Azure.DnsResolver.Policy("dns-security", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Policy with tags
 * ```typescript
 * const policy = yield* Azure.DnsResolver.Policy("dns-security", {
 *   resourceGroup: group.resourceGroupName,
 *   tags: { team: "security" },
 * });
 * ```
 *
 * @resource
 */
export const Policy = Resource<Policy>("Azure.DnsResolver.Policy");

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsResolverPolicyName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetDnsResolverPolicy({
      subscriptionId,
      resourceGroupName,
      dnsResolverPolicyName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  policy:
    | dnsresolver.GetDnsResolverPolicyResponse
    | dnsresolver.DnsResolverPolicy,
): Policy["Attributes"] => ({
  policyName: name,
  policyId: policy.id ?? "",
  resourceGroup,
  location: policy.location,
  resourceGuid: policy.properties?.resourceGuid,
  tags: userTags(policy.tags),
});

export const PolicyProvider = () =>
  Provider.succeed(Policy, {
    stables: [
      "policyName",
      "policyId",
      "resourceGroup",
      "location",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* dnsresolver
        .ListDnsResolverPolicies({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDnsResolverPolicies", page),
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
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.policyName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.policyName ?? olds?.name ?? (yield* createDnsResolverName(id));
      const observed = yield* getPolicy(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.policyName ?? (yield* createDnsResolverName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsResolverPolicyName: name,
      };
      const get = getPolicy(subscriptionId, resourceGroup, name);
      const label = `DNS resolver policy ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* dnsresolver.DnsResolverPoliciesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {},
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (policy) => policy.properties?.provisioningState,
        FAST_BUDGET,
      );

      // Sync tags (the only mutable aspect) against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* dnsresolver.UpdateDnsResolverPolicy({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (policy) =>
            tagsDiffer(policy.tags, tags)
              ? "Updating"
              : policy.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver
          .DeleteDnsResolverPolicy({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            dnsResolverPolicyName: output.policyName,
          })
          .pipe(Effect.retry(whileNestedResourcesExist)),
      );
      yield* waitUntilGone(
        `DNS resolver policy ${output.policyName}`,
        getPolicy(subscriptionId, output.resourceGroup, output.policyName),
        FAST_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
