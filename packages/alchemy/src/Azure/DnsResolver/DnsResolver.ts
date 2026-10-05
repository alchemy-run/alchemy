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
  ENDPOINT_BUDGET,
  sameArm,
  whileNestedResourcesExist,
} from "./Common.ts";

export interface DnsResolverProps {
  /**
   * Resource group the resolver is created in. The DNS resolver API rejects resource group names
   * longer than 80 characters. Changing it replaces the resolver.
   */
  resourceGroup: string;
  /**
   * Resolver name: 1-80 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the resolver.
   */
  name?: string;
  /**
   * Azure location of the resolver; must match the virtual network's
   * location. Changing it replaces the resolver.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the virtual network the resolver serves. A virtual network
   * holds at most one resolver. Changing it replaces the resolver.
   */
  virtualNetworkId: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DnsResolver extends Resource<
  "Azure.DnsResolver.DnsResolver",
  DnsResolverProps,
  {
    /** Name of the resolver. */
    dnsResolverName: string;
    /** ARM resource ID of the resolver. */
    dnsResolverId: string;
    /** Resource group that holds the resolver. */
    resourceGroup: string;
    /** Location of the resolver. */
    location: string;
    /** ARM ID of the virtual network the resolver serves. */
    virtualNetworkId: string;
    /** Whether the resolver is `Connected` to its virtual network. */
    dnsResolverState: string | undefined;
    /** Immutable GUID Azure assigns to the resolver. */
    resourceGuid: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure DNS Private Resolver — a managed DNS service inside a virtual
 * network that resolves Azure Private DNS zones from on-premises and
 * forwards queries from the virtual network to other DNS servers.
 *
 * The resolver itself is free; its inbound and outbound endpoints are
 * billed hourly. Add endpoints with `Azure.DnsResolver.InboundEndpoint` and
 * `Azure.DnsResolver.OutboundEndpoint`.
 *
 * @see https://learn.microsoft.com/azure/dns/dns-private-resolver-overview
 *
 * ### Creating a Resolver
 * **Example:** Resolver for a virtual network
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("network");
 * const resolver = yield* Azure.DnsResolver.DnsResolver("resolver", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetworkId: vnetId,
 * });
 * ```
 *
 * **Example:** Resolver with tags
 * ```typescript
 * const resolver = yield* Azure.DnsResolver.DnsResolver("resolver", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetworkId: vnetId,
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 */
export const DnsResolver = Resource<DnsResolver>(
  "Azure.DnsResolver.DnsResolver",
);

type Observed = dnsresolver.GetDnsResolverResponse;

const getResolver = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsResolverName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetDnsResolver({
      subscriptionId,
      resourceGroupName,
      dnsResolverName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  resolver: Observed | dnsresolver.DnsResolver,
): DnsResolver["Attributes"] => ({
  dnsResolverName: name,
  dnsResolverId: resolver.id ?? "",
  resourceGroup,
  location: resolver.location,
  virtualNetworkId: resolver.properties.virtualNetwork.id,
  dnsResolverState: resolver.properties.dnsResolverState,
  resourceGuid: resolver.properties.resourceGuid,
  tags: userTags(resolver.tags),
});

export const DnsResolverProvider = () =>
  Provider.succeed(DnsResolver, {
    stables: [
      "dnsResolverName",
      "dnsResolverId",
      "resourceGroup",
      "location",
      "virtualNetworkId",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* dnsresolver
        .ListDnsResolvers({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListDnsResolvers", page)),
        );
      return (page.value ?? []).flatMap((resolver) => {
        const group = resourceGroupOf(resolver.id);
        return hasAnyAlchemyTag(resolver.tags) &&
          group !== undefined &&
          resolver.name !== undefined
          ? [toAttrs(group, resolver.name, resolver)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameNetwork = sameArm(
        news.virtualNetworkId,
        output.virtualNetworkId,
      );
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.dnsResolverName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameNetwork
      ) {
        // A virtual network holds one resolver: when the network stays the
        // same the old resolver must go before the new one can be created.
        return { action: "replace", deleteFirst: sameNetwork } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.dnsResolverName ??
        olds?.name ??
        (yield* createDnsResolverName(id));
      const observed = yield* getResolver(subscriptionId, resourceGroup, name);
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
        output?.dnsResolverName ??
        (yield* createDnsResolverName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsResolverName: name,
      };
      const get = getResolver(subscriptionId, resourceGroup, name);
      const label = `DNS resolver ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* dnsresolver.DnsResolversCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { virtualNetwork: { id: news.virtualNetworkId } },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (resolver) => resolver.properties.provisioningState,
        ENDPOINT_BUDGET,
      );

      // Sync tags (the only mutable aspect) against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* dnsresolver.UpdateDnsResolver({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (resolver) =>
            tagsDiffer(resolver.tags, tags)
              ? "Updating"
              : resolver.properties.provisioningState,
          ENDPOINT_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver
          .DeleteDnsResolver({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            dnsResolverName: output.dnsResolverName,
          })
          .pipe(Effect.retry(whileNestedResourcesExist)),
      );
      yield* waitUntilGone(
        `DNS resolver ${output.dnsResolverName}`,
        getResolver(
          subscriptionId,
          output.resourceGroup,
          output.dnsResolverName,
        ),
        ENDPOINT_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
