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
import { createDnsResolverName, FAST_BUDGET, sameArm } from "./Common.ts";

export interface PolicyVirtualNetworkLinkProps {
  /**
   * Resource group of the DNS security policy. The DNS resolver API rejects
   * resource group names longer than 80 characters. Changing it replaces
   * the link.
   */
  resourceGroup: string;
  /**
   * Name of the DNS security policy to link. Changing it replaces the link.
   */
  dnsResolverPolicy: string;
  /**
   * Link name: 1-80 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the link.
   */
  name?: string;
  /**
   * Azure location of the link; must match the policy and the virtual
   * network. Changing it replaces the link.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the virtual network whose DNS queries the policy filters. A
   * virtual network can be linked to only one DNS security policy.
   * Changing it replaces the link.
   */
  virtualNetworkId: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PolicyVirtualNetworkLink extends Resource<
  "Azure.DnsResolver.PolicyVirtualNetworkLink",
  PolicyVirtualNetworkLinkProps,
  {
    /** Name of the link. */
    virtualNetworkLinkName: string;
    /** ARM resource ID of the link. */
    virtualNetworkLinkId: string;
    /** Name of the linked DNS security policy. */
    dnsResolverPolicy: string;
    /** Resource group of the policy. */
    resourceGroup: string;
    /** Location of the link. */
    location: string;
    /** ARM ID of the linked virtual network. */
    virtualNetworkId: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Links a virtual network to an Azure DNS security policy so the policy's
 * DNS security rules filter and log the network's DNS queries.
 *
 * A virtual network can be linked to only one DNS security policy, and
 * the link must be in the same region as the policy and the network.
 *
 * @see https://learn.microsoft.com/azure/dns/dns-security-policy
 *
 * ### Linking a Virtual Network
 * **Example:** Apply a DNS security policy to a network
 * ```typescript
 * const policy = yield* Azure.DnsResolver.Policy("dns-security", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const link = yield* Azure.DnsResolver.PolicyVirtualNetworkLink("app-vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsResolverPolicy: policy.policyName,
 *   virtualNetworkId: vnetId,
 * });
 * ```
 *
 * **Example:** Link with tags
 * ```typescript
 * const link = yield* Azure.DnsResolver.PolicyVirtualNetworkLink("app-vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsResolverPolicy: policy.policyName,
 *   virtualNetworkId: vnetId,
 *   tags: { team: "security" },
 * });
 * ```
 *
 * @resource
 */
export const PolicyVirtualNetworkLink = Resource<PolicyVirtualNetworkLink>(
  "Azure.DnsResolver.PolicyVirtualNetworkLink",
);

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsResolverPolicyName: string,
  dnsResolverPolicyVirtualNetworkLinkName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetDnsResolverPolicyVirtualNetworkLink({
      subscriptionId,
      resourceGroupName,
      dnsResolverPolicyName,
      dnsResolverPolicyVirtualNetworkLinkName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  policyName: string,
  name: string,
  link:
    | dnsresolver.GetDnsResolverPolicyVirtualNetworkLinkResponse
    | dnsresolver.DnsResolverPolicyVirtualNetworkLink,
): PolicyVirtualNetworkLink["Attributes"] => ({
  virtualNetworkLinkName: name,
  virtualNetworkLinkId: link.id ?? "",
  dnsResolverPolicy: policyName,
  resourceGroup,
  location: link.location,
  virtualNetworkId: link.properties.virtualNetwork.id,
  tags: userTags(link.tags),
});

export const PolicyVirtualNetworkLinkProvider = () =>
  Provider.succeed(PolicyVirtualNetworkLink, {
    stables: [
      "virtualNetworkLinkName",
      "virtualNetworkLinkId",
      "dnsResolverPolicy",
      "resourceGroup",
      "location",
      "virtualNetworkId",
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
      const found: PolicyVirtualNetworkLink["Attributes"][] = [];
      for (const policy of policies.value ?? []) {
        const group = resourceGroupOf(policy.id);
        if (group === undefined || policy.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          dnsresolver.ListDnsResolverPolicyVirtualNetworkLinks({
            subscriptionId,
            resourceGroupName: group,
            dnsResolverPolicyName: policy.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage(
            "ListDnsResolverPolicyVirtualNetworkLinks",
            page,
          );
        }
        for (const link of page?.value ?? []) {
          if (hasAnyAlchemyTag(link.tags) && link.name !== undefined) {
            found.push(toAttrs(group, policy.name, link.name, link));
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
      const sameNetwork = sameArm(
        news.virtualNetworkId,
        output.virtualNetworkId,
      );
      if (
        !samePolicy ||
        !sameNetwork ||
        (news.name !== undefined &&
          news.name !== output.virtualNetworkLinkName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        // A virtual network can be linked to only one DNS security policy,
        // so the old link must go before a link to the same network is made.
        return { action: "replace", deleteFirst: sameNetwork } as const;
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
        output?.virtualNetworkLinkName ??
        olds?.name ??
        (yield* createDnsResolverName(id));
      const observed = yield* getLink(
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
        output?.virtualNetworkLinkName ??
        (yield* createDnsResolverName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsResolverPolicyName: policyName,
        dnsResolverPolicyVirtualNetworkLinkName: name,
      };
      const get = getLink(subscriptionId, resourceGroup, policyName, name);
      const label = `DNS resolver policy link ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Link creation is a long-running operation.
      if (observed === undefined) {
        yield* dnsresolver.DnsResolverPolicyVirtualNetworkLinksCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { virtualNetwork: { id: news.virtualNetworkId } },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (link) => link.properties.provisioningState,
        FAST_BUDGET,
      );

      // Sync tags (the only mutable aspect) against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* dnsresolver.UpdateDnsResolverPolicyVirtualNetworkLink({
          ...where,
          tags,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (link) =>
            tagsDiffer(link.tags, tags)
              ? "Updating"
              : link.properties.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, policyName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver.DeleteDnsResolverPolicyVirtualNetworkLink({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          dnsResolverPolicyName: output.dnsResolverPolicy,
          dnsResolverPolicyVirtualNetworkLinkName:
            output.virtualNetworkLinkName,
        }),
      );
      yield* waitUntilGone(
        `DNS resolver policy link ${output.virtualNetworkLinkName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.dnsResolverPolicy,
          output.virtualNetworkLinkName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DnsResolver.Policy",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
