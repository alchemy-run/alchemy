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
  whileNestedResourcesExist,
} from "./Common.ts";

export interface ForwardingRulesetProps {
  /**
   * Resource group the ruleset is created in. The DNS resolver API rejects resource group names
   * longer than 80 characters. Changing it replaces the ruleset.
   */
  resourceGroup: string;
  /**
   * Ruleset name: 1-80 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the ruleset.
   */
  name?: string;
  /**
   * Azure location of the ruleset; must match the outbound endpoints'
   * location. Changing it replaces the ruleset.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM IDs of the DNS resolver outbound endpoints that send the matching
   * queries to the target DNS servers (at least one).
   */
  outboundEndpointIds: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ForwardingRuleset extends Resource<
  "Azure.DnsResolver.ForwardingRuleset",
  ForwardingRulesetProps,
  {
    /** Name of the ruleset. */
    dnsForwardingRulesetName: string;
    /** ARM resource ID of the ruleset. */
    dnsForwardingRulesetId: string;
    /** Resource group that holds the ruleset. */
    resourceGroup: string;
    /** Location of the ruleset. */
    location: string;
    /** ARM IDs of the outbound endpoints the ruleset uses. */
    outboundEndpointIds: string[];
    /** Immutable GUID Azure assigns to the ruleset. */
    resourceGuid: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure DNS forwarding ruleset — a set of conditional forwarding rules
 * that DNS Private Resolver outbound endpoints apply to queries from the
 * virtual networks linked to the ruleset.
 *
 * Add rules with `Azure.DnsResolver.ForwardingRule` and link virtual
 * networks with `Azure.DnsResolver.ForwardingRulesetVirtualNetworkLink`.
 *
 * @see https://learn.microsoft.com/azure/dns/private-resolver-endpoints-rulesets
 *
 * ### Creating a Ruleset
 * **Example:** Ruleset on one outbound endpoint
 * ```typescript
 * const ruleset = yield* Azure.DnsResolver.ForwardingRuleset("rules", {
 *   resourceGroup: group.resourceGroupName,
 *   outboundEndpointIds: [outbound.outboundEndpointId],
 * });
 * ```
 *
 * ### Forwarding a Domain
 * **Example:** Forward `corp.example.com` to on-premises DNS servers
 * ```typescript
 * yield* Azure.DnsResolver.ForwardingRule("corp", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsForwardingRuleset: ruleset.dnsForwardingRulesetName,
 *   domainName: "corp.example.com.",
 *   targetDnsServers: [{ ipAddress: "10.10.0.4" }],
 * });
 * ```
 *
 * @resource
 */
export const ForwardingRuleset = Resource<ForwardingRuleset>(
  "Azure.DnsResolver.ForwardingRuleset",
);

const getRuleset = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsForwardingRulesetName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetDnsForwardingRuleset({
      subscriptionId,
      resourceGroupName,
      dnsForwardingRulesetName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  ruleset:
    | dnsresolver.GetDnsForwardingRulesetResponse
    | dnsresolver.DnsForwardingRuleset,
): ForwardingRuleset["Attributes"] => ({
  dnsForwardingRulesetName: name,
  dnsForwardingRulesetId: ruleset.id ?? "",
  resourceGroup,
  location: ruleset.location,
  outboundEndpointIds: ruleset.properties.dnsResolverOutboundEndpoints.map(
    (endpoint) => endpoint.id,
  ),
  resourceGuid: ruleset.properties.resourceGuid,
  tags: userTags(ruleset.tags),
});

export const ForwardingRulesetProvider = () =>
  Provider.succeed(ForwardingRuleset, {
    stables: [
      "dnsForwardingRulesetName",
      "dnsForwardingRulesetId",
      "resourceGroup",
      "location",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* dnsresolver
        .ListDnsForwardingRulesets({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListDnsForwardingRulesets", page),
          ),
        );
      return (page.value ?? []).flatMap((ruleset) => {
        const group = resourceGroupOf(ruleset.id);
        return hasAnyAlchemyTag(ruleset.tags) &&
          group !== undefined &&
          ruleset.name !== undefined
          ? [toAttrs(group, ruleset.name, ruleset)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          news.name !== output.dnsForwardingRulesetName) ||
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
        output?.dnsForwardingRulesetName ??
        olds?.name ??
        (yield* createDnsResolverName(id));
      const observed = yield* getRuleset(subscriptionId, resourceGroup, name);
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
        news.name ??
        output?.dnsForwardingRulesetName ??
        (yield* createDnsResolverName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const endpoints = news.outboundEndpointIds.map((endpointId) => ({
        id: endpointId,
      }));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsForwardingRulesetName: name,
      };
      const get = getRuleset(subscriptionId, resourceGroup, name);
      const label = `DNS forwarding ruleset ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* dnsresolver.DnsForwardingRulesetsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { dnsResolverOutboundEndpoints: endpoints },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (ruleset) => ruleset.properties.provisioningState,
        FAST_BUDGET,
      );

      // Sync outbound endpoints and tags against observed state.
      const endpointsChanged = !sameArmIds(
        observed.properties.dnsResolverOutboundEndpoints.map((e) => e.id),
        news.outboundEndpointIds,
      );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (endpointsChanged || tagsChanged) {
        yield* dnsresolver.UpdateDnsForwardingRuleset({
          ...where,
          dnsResolverOutboundEndpoints: endpointsChanged
            ? endpoints
            : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (ruleset) =>
            tagsDiffer(ruleset.tags, tags) ||
            !sameArmIds(
              ruleset.properties.dnsResolverOutboundEndpoints.map((e) => e.id),
              news.outboundEndpointIds,
            )
              ? "Updating"
              : ruleset.properties.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver
          .DeleteDnsForwardingRuleset({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            dnsForwardingRulesetName: output.dnsForwardingRulesetName,
          })
          .pipe(Effect.retry(whileNestedResourcesExist)),
      );
      yield* waitUntilGone(
        `DNS forwarding ruleset ${output.dnsForwardingRulesetName}`,
        getRuleset(
          subscriptionId,
          output.resourceGroup,
          output.dnsForwardingRulesetName,
        ),
        FAST_BUDGET,
      );
    }),

    // The ruleset must be gone before its outbound endpoints can be deleted.
    nuke: {
      dependsOn: [
        "Azure.DnsResolver.OutboundEndpoint",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
