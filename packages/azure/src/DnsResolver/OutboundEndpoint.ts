import * as dnsresolver from "@distilled.cloud/azure/dnsresolver";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
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
import {
  createDnsResolverName,
  ENDPOINT_BUDGET,
  sameArm,
  whileNestedResourcesExist,
} from "./Common.ts";

export interface OutboundEndpointProps {
  /**
   * Resource group of the resolver. The DNS resolver API rejects resource group names
   * longer than 80 characters. Changing it replaces the endpoint.
   * @default the stack's resource group
   */
  resourceGroup: string;
  /** Name of the DNS resolver that owns the endpoint. Changing it replaces the endpoint. */
  dnsResolver: string;
  /**
   * Endpoint name: 1-80 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the endpoint.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the endpoint; must match the resolver's location.
   * Changing it replaces the endpoint.
   * @default the resolver's location
   */
  location?: string;
  /**
   * ARM ID of the subnet queries leave from. The subnet must be delegated
   * to `Microsoft.Network/dnsResolvers`, be at least `/28`, and hold no
   * other resources (including an inbound endpoint). Changing it replaces
   * the endpoint.
   */
  subnetId: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface OutboundEndpoint extends Resource<
  "Azure.DnsResolver.OutboundEndpoint",
  OutboundEndpointProps,
  {
    /** Name of the endpoint. */
    outboundEndpointName: string;
    /** ARM resource ID of the endpoint; reference it from forwarding rulesets. */
    outboundEndpointId: string;
    /** Name of the resolver that owns the endpoint. */
    dnsResolver: string;
    /** Resource group of the resolver. */
    resourceGroup: string;
    /** Location of the endpoint. */
    location: string;
    /** ARM ID of the subnet the endpoint uses. */
    subnetId: string;
    /** Immutable GUID Azure assigns to the endpoint. */
    resourceGuid: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An outbound endpoint of an Azure DNS Private Resolver
 * (`Microsoft.Network/dnsResolvers/outboundEndpoints`) — the egress point
 * for queries that a DNS forwarding ruleset sends to other DNS servers
 * (e.g. on-premises). See
 * [endpoints and rulesets](https://learn.microsoft.com/azure/dns/private-resolver-endpoints-rulesets).
 *
 * Outbound endpoints are billed hourly (about $0.25/hour).
 *
 * :::caution
 * The subnet must be delegated to `Microsoft.Network/dnsResolvers`, be at
 * least `/28`, and hold nothing else (not even an inbound endpoint).
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `dnsResolver`, `name`, `location`, or
 * `subnetId` replaces the endpoint. A replacement on the same subnet
 * deletes the old endpoint first.
 * :::
 *
 * ### Creating an Outbound Endpoint
 * **Example:** Endpoint used by a forwarding ruleset
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const outboundSubnet = yield* Azure.Network.Subnet("outbound", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/28",
 *   delegations: [{ serviceName: "Microsoft.Network/dnsResolvers" }],
 * });
 * const resolver = yield* Azure.DnsResolver.DnsResolver("resolver", {
 *   virtualNetworkId: vnet.virtualNetworkId,
 * });
 * const outbound = yield* Azure.DnsResolver.OutboundEndpoint("outbound", {
 *   dnsResolver: resolver.dnsResolverName,
 *   subnetId: outboundSubnet.subnetId,
 * });
 * const ruleset = yield* Azure.DnsResolver.ForwardingRuleset("rules", {
 *   outboundEndpointIds: [outbound.outboundEndpointId],
 * });
 * ```
 *
 * @resource
 */
export const OutboundEndpoint = GroupedResource<OutboundEndpoint>(
  "Azure.DnsResolver.OutboundEndpoint",
);

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsResolverName: string,
  outboundEndpointName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetOutboundEndpoint({
      subscriptionId,
      resourceGroupName,
      dnsResolverName,
      outboundEndpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  dnsResolverName: string,
  name: string,
  endpoint: dnsresolver.GetOutboundEndpointResponse | dnsresolver.OutboundEndpoint,
): OutboundEndpoint["Attributes"] => ({
  outboundEndpointName: name,
  outboundEndpointId: endpoint.id ?? "",
  dnsResolver: dnsResolverName,
  resourceGroup,
  location: endpoint.location,
  subnetId: endpoint.properties.subnet.id,
  resourceGuid: endpoint.properties.resourceGuid,
  tags: userTags(endpoint.tags),
});

export const OutboundEndpointProvider = () =>
  Provider.succeed(OutboundEndpoint, {
    stables: [
      "outboundEndpointName",
      "outboundEndpointId",
      "dnsResolver",
      "resourceGroup",
      "location",
      "subnetId",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resolvers = yield* collectAll(dnsresolver.ListDnsResolvers, { subscriptionId });
      const found: OutboundEndpoint["Attributes"][] = [];
      for (const resolver of resolvers.value ?? []) {
        const group = resourceGroupOf(resolver.id);
        if (group === undefined || resolver.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          collectAll(dnsresolver.ListOutboundEndpoints, {
            subscriptionId,
            resourceGroupName: group,
            dnsResolverName: resolver.name,
          }),
        );
        for (const endpoint of page?.value ?? []) {
          if (hasAnyAlchemyTag(endpoint.tags) && endpoint.name !== undefined) {
            found.push(toAttrs(group, resolver.name, endpoint.name, endpoint));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameSubnet = sameArm(news.subnetId, output.subnetId);
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.dnsResolver, output.dnsResolver) ||
        (news.name !== undefined && news.name !== output.outboundEndpointName) ||
        (news.location !== undefined && !sameArm(news.location, output.location)) ||
        !sameSubnet
      ) {
        // A delegated subnet holds a single endpoint.
        return { action: "replace", deleteFirst: sameSubnet } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const dnsResolverName = output?.dnsResolver ?? olds?.dnsResolver;
      if (resourceGroup === undefined || dnsResolverName === undefined) {
        return undefined;
      }
      const name = output?.outboundEndpointName ?? olds?.name ?? (yield* createDnsResolverName(id));
      const observed = yield* getEndpoint(subscriptionId, resourceGroup, dnsResolverName, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, dnsResolverName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, dnsResolver: dnsResolverName } = news;
      const name = news.name ?? output?.outboundEndpointName ?? (yield* createDnsResolverName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsResolverName,
        outboundEndpointName: name,
      };
      const get = getEndpoint(subscriptionId, resourceGroup, dnsResolverName, name);
      const label = `DNS resolver outbound endpoint ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. The endpoint must live in its resolver's location.
      if (observed === undefined) {
        const location =
          news.location ??
          output?.location ??
          (yield* orUndefinedIfNotFound(
            dnsresolver.GetDnsResolver({
              subscriptionId,
              resourceGroupName: resourceGroup,
              dnsResolverName,
            }),
          ))?.location ??
          env.location;
        yield* dnsresolver.OutboundEndpointsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: { subnet: { id: news.subnetId } },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (endpoint) => endpoint.properties.provisioningState,
        ENDPOINT_BUDGET,
      );

      // Sync tags (the subnet is immutable; diff replaces).
      if (tagsDiffer(observed.tags, tags)) {
        yield* dnsresolver.UpdateOutboundEndpoint({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (endpoint) =>
            tagsDiffer(endpoint.tags, tags) ? "Updating" : endpoint.properties.provisioningState,
          ENDPOINT_BUDGET,
        );
      }

      return toAttrs(resourceGroup, dnsResolverName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver
          .DeleteOutboundEndpoint({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            dnsResolverName: output.dnsResolver,
            outboundEndpointName: output.outboundEndpointName,
          })
          .pipe(Effect.retry(whileNestedResourcesExist)),
      );
      yield* waitUntilGone(
        `DNS resolver outbound endpoint ${output.outboundEndpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.dnsResolver,
          output.outboundEndpointName,
        ),
        ENDPOINT_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.DnsResolver.DnsResolver", "Azure.Resources.ResourceGroup"],
    },
  });
