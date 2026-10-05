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

export interface ForwardingRulesetVirtualNetworkLinkProps {
  /**
   * Resource group of the ruleset. The DNS resolver API rejects resource group names
   * longer than 80 characters. Changing it replaces the link.
   */
  resourceGroup: string;
  /** Name of the DNS forwarding ruleset to link. Changing it replaces the link. */
  dnsForwardingRuleset: string;
  /**
   * Link name: 1-80 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the link.
   */
  name?: string;
  /**
   * ARM ID of the virtual network whose DNS queries the ruleset applies
   * to. Changing it replaces the link.
   */
  virtualNetworkId: string;
  /**
   * User metadata. Alchemy ownership markers (`alchemy::stack`,
   * `alchemy::stage`, `alchemy::id`) are merged in because links have no
   * tags.
   */
  metadata?: Record<string, string>;
}

export interface ForwardingRulesetVirtualNetworkLink extends Resource<
  "Azure.DnsResolver.ForwardingRulesetVirtualNetworkLink",
  ForwardingRulesetVirtualNetworkLinkProps,
  {
    /** Name of the link. */
    virtualNetworkLinkName: string;
    /** ARM resource ID of the link. */
    virtualNetworkLinkId: string;
    /** Name of the linked ruleset. */
    dnsForwardingRuleset: string;
    /** Resource group of the ruleset. */
    resourceGroup: string;
    /** ARM ID of the linked virtual network. */
    virtualNetworkId: string;
    /** User metadata (Alchemy ownership markers stripped). */
    metadata: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Links a virtual network to an Azure DNS forwarding ruleset so the
 * ruleset's forwarding rules apply to DNS queries from that network.
 *
 * Links cannot be tagged, so Alchemy records ownership in the link's
 * metadata.
 *
 * @see https://learn.microsoft.com/azure/dns/private-resolver-endpoints-rulesets#ruleset-links
 *
 * ### Linking a Virtual Network
 * **Example:** Apply a ruleset to a spoke network
 * ```typescript
 * const link = yield* Azure.DnsResolver.ForwardingRulesetVirtualNetworkLink(
 *   "spoke",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     dnsForwardingRuleset: ruleset.dnsForwardingRulesetName,
 *     virtualNetworkId: spokeVnetId,
 *   },
 * );
 * ```
 *
 * @resource
 */
export const ForwardingRulesetVirtualNetworkLink =
  Resource<ForwardingRulesetVirtualNetworkLink>(
    "Azure.DnsResolver.ForwardingRulesetVirtualNetworkLink",
  );

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsForwardingRulesetName: string,
  virtualNetworkLinkName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetVirtualNetworkLink({
      subscriptionId,
      resourceGroupName,
      dnsForwardingRulesetName,
      virtualNetworkLinkName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  rulesetName: string,
  name: string,
  link:
    | dnsresolver.GetVirtualNetworkLinkResponse
    | dnsresolver.VirtualNetworkLink,
): ForwardingRulesetVirtualNetworkLink["Attributes"] => ({
  virtualNetworkLinkName: name,
  virtualNetworkLinkId: link.id ?? "",
  dnsForwardingRuleset: rulesetName,
  resourceGroup,
  virtualNetworkId: link.properties.virtualNetwork.id,
  metadata: userTags(link.properties.metadata),
});

export const ForwardingRulesetVirtualNetworkLinkProvider = () =>
  Provider.succeed(ForwardingRulesetVirtualNetworkLink, {
    stables: [
      "virtualNetworkLinkName",
      "virtualNetworkLinkId",
      "dnsForwardingRuleset",
      "resourceGroup",
      "virtualNetworkId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const rulesets = yield* dnsresolver
        .ListDnsForwardingRulesets({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDnsForwardingRulesets", page),
          ),
        );
      const found: ForwardingRulesetVirtualNetworkLink["Attributes"][] = [];
      for (const ruleset of rulesets.value ?? []) {
        const group = resourceGroupOf(ruleset.id);
        if (group === undefined || ruleset.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          dnsresolver.ListVirtualNetworkLinks({
            subscriptionId,
            resourceGroupName: group,
            dnsForwardingRulesetName: ruleset.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListVirtualNetworkLinks", page);
        }
        for (const link of page?.value ?? []) {
          if (
            hasAnyAlchemyTag(link.properties.metadata) &&
            link.name !== undefined
          ) {
            found.push(toAttrs(group, ruleset.name, link.name, link));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameRuleset =
        sameArm(news.resourceGroup, output.resourceGroup) &&
        sameArm(news.dnsForwardingRuleset, output.dnsForwardingRuleset);
      const sameNetwork = sameArm(
        news.virtualNetworkId,
        output.virtualNetworkId,
      );
      if (
        !sameRuleset ||
        !sameNetwork ||
        (news.name !== undefined && news.name !== output.virtualNetworkLinkName)
      ) {
        // A virtual network can be linked to a ruleset only once.
        return {
          action: "replace",
          deleteFirst: sameRuleset && sameNetwork,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const rulesetName =
        output?.dnsForwardingRuleset ?? olds?.dnsForwardingRuleset;
      if (resourceGroup === undefined || rulesetName === undefined) {
        return undefined;
      }
      const name =
        output?.virtualNetworkLinkName ??
        olds?.name ??
        (yield* createDnsResolverName(id));
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        rulesetName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, rulesetName, name, observed);
      return (yield* isOwned(id, observed.properties.metadata))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, dnsForwardingRuleset: rulesetName } = news;
      const name =
        news.name ??
        output?.virtualNetworkLinkName ??
        (yield* createDnsResolverName(id));
      const metadata = yield* desiredTags(id, news.metadata);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsForwardingRulesetName: rulesetName,
        virtualNetworkLinkName: name,
      };
      const get = getLink(subscriptionId, resourceGroup, rulesetName, name);
      const label = `DNS forwarding ruleset link ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Link creation is a long-running operation.
      if (observed === undefined) {
        yield* dnsresolver.VirtualNetworkLinksCreateOrUpdate({
          ...where,
          properties: {
            virtualNetwork: { id: news.virtualNetworkId },
            metadata,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (link) => link.properties.provisioningState,
        FAST_BUDGET,
      );

      // Sync metadata (the only mutable aspect) against observed state.
      if (tagsDiffer(observed.properties.metadata, metadata)) {
        yield* dnsresolver.UpdateVirtualNetworkLink({
          ...where,
          properties: { metadata },
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (link) =>
            tagsDiffer(link.properties.metadata, metadata)
              ? "Updating"
              : link.properties.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, rulesetName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver.DeleteVirtualNetworkLink({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          dnsForwardingRulesetName: output.dnsForwardingRuleset,
          virtualNetworkLinkName: output.virtualNetworkLinkName,
        }),
      );
      yield* waitUntilGone(
        `DNS forwarding ruleset link ${output.virtualNetworkLinkName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.dnsForwardingRuleset,
          output.virtualNetworkLinkName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DnsResolver.ForwardingRuleset",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
