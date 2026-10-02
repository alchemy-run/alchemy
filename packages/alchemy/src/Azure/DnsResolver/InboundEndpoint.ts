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
import { createDnsResolverName, ENDPOINT_BUDGET, sameArm } from "./Common.ts";

export type PrivateIpAllocationMethod = "Static" | "Dynamic";

export interface InboundEndpointIpConfiguration {
  /**
   * ARM ID of the subnet the endpoint's IP comes from. The subnet must be
   * delegated to `Microsoft.Network/dnsResolvers`, be at least `/28`, and
   * hold no other resources.
   */
  subnetId: string;
  /**
   * How the private IP is assigned.
   * @default "Dynamic"
   */
  privateIpAllocationMethod?: PrivateIpAllocationMethod;
  /** Private IP address to use with `Static` allocation. */
  privateIpAddress?: string;
}

export interface InboundEndpointProps {
  /**
   * Resource group of the resolver. The DNS resolver API rejects resource group names
   * longer than 80 characters. Changing it replaces the endpoint.
   */
  resourceGroup: string;
  /** Name of the DNS resolver that owns the endpoint. Changing it replaces the endpoint. */
  dnsResolver: string;
  /**
   * Endpoint name: 1-80 letters, digits, `_`, and `-`. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the endpoint.
   */
  name?: string;
  /**
   * Azure location of the endpoint; must match the resolver's location.
   * Changing it replaces the endpoint.
   * @default the resolver's location
   */
  location?: string;
  /**
   * IP configurations of the endpoint (one per subnet). Inbound endpoints
   * cannot be updated in place: changing them replaces the endpoint.
   */
  ipConfigurations: InboundEndpointIpConfiguration[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface InboundEndpointObservedIpConfiguration {
  /** ARM ID of the subnet. */
  subnetId: string;
  /** Private IP address Azure assigned (or the static one requested). */
  privateIpAddress: string | undefined;
  /** How the private IP was assigned. */
  privateIpAllocationMethod: string | undefined;
}

export interface InboundEndpoint extends Resource<
  "Azure.DnsResolver.InboundEndpoint",
  InboundEndpointProps,
  {
    /** Name of the endpoint. */
    inboundEndpointName: string;
    /** ARM resource ID of the endpoint. */
    inboundEndpointId: string;
    /** Name of the resolver that owns the endpoint. */
    dnsResolver: string;
    /** Resource group of the resolver. */
    resourceGroup: string;
    /** Location of the endpoint. */
    location: string;
    /** Observed IP configurations, including the assigned private IPs. */
    ipConfigurations: InboundEndpointObservedIpConfiguration[];
    /**
     * Private IP addresses DNS clients (e.g. on-premises forwarders) send
     * queries to.
     */
    privateIpAddresses: string[];
    /** Immutable GUID Azure assigns to the endpoint. */
    resourceGuid: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An inbound endpoint of an Azure DNS Private Resolver — a private IP in a
 * delegated subnet that on-premises or peered networks send DNS queries to,
 * so they can resolve Azure Private DNS zones.
 *
 * Inbound endpoints are billed hourly (about $0.25/hour). The subnet must
 * be delegated to `Microsoft.Network/dnsResolvers` and dedicated to the
 * endpoint.
 *
 * @see https://learn.microsoft.com/azure/dns/private-resolver-endpoints-rulesets
 *
 * ### Creating an Inbound Endpoint
 * **Example:** Endpoint with a dynamic private IP
 * ```typescript
 * const inbound = yield* Azure.DnsResolver.InboundEndpoint("inbound", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsResolver: resolver.dnsResolverName,
 *   ipConfigurations: [{ subnetId: inboundSubnetId }],
 * });
 * // point on-premises conditional forwarders at inbound.privateIpAddresses
 * ```
 *
 * **Example:** Endpoint with a static private IP
 * ```typescript
 * const inbound = yield* Azure.DnsResolver.InboundEndpoint("inbound", {
 *   resourceGroup: group.resourceGroupName,
 *   dnsResolver: resolver.dnsResolverName,
 *   ipConfigurations: [
 *     {
 *       subnetId: inboundSubnetId,
 *       privateIpAllocationMethod: "Static",
 *       privateIpAddress: "10.0.0.4",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const InboundEndpoint = Resource<InboundEndpoint>(
  "Azure.DnsResolver.InboundEndpoint",
);

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  dnsResolverName: string,
  inboundEndpointName: string,
) =>
  orUndefinedIfNotFound(
    dnsresolver.GetInboundEndpoint({
      subscriptionId,
      resourceGroupName,
      dnsResolverName,
      inboundEndpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  dnsResolverName: string,
  name: string,
  endpoint:
    | dnsresolver.GetInboundEndpointResponse
    | dnsresolver.InboundEndpoint,
): InboundEndpoint["Attributes"] => {
  const ipConfigurations = endpoint.properties.ipConfigurations.map(
    (config) => ({
      subnetId: config.subnet.id,
      privateIpAddress: config.privateIpAddress,
      privateIpAllocationMethod: config.privateIpAllocationMethod,
    }),
  );
  return {
    inboundEndpointName: name,
    inboundEndpointId: endpoint.id ?? "",
    dnsResolver: dnsResolverName,
    resourceGroup,
    location: endpoint.location,
    ipConfigurations,
    privateIpAddresses: ipConfigurations.flatMap((config) =>
      config.privateIpAddress === undefined ? [] : [config.privateIpAddress],
    ),
    resourceGuid: endpoint.properties.resourceGuid,
    tags: userTags(endpoint.tags),
  };
};

/** Whether the desired IP configurations match the observed ones. */
const sameIpConfigurations = (
  desired: ReadonlyArray<InboundEndpointIpConfiguration>,
  observed: ReadonlyArray<InboundEndpointObservedIpConfiguration>,
) =>
  desired.length === observed.length &&
  desired.every((want) => {
    const have = observed.find((config) =>
      sameArm(config.subnetId, want.subnetId),
    );
    return (
      have !== undefined &&
      sameArm(
        want.privateIpAllocationMethod ?? "Dynamic",
        have.privateIpAllocationMethod ?? "Dynamic",
      ) &&
      (want.privateIpAddress === undefined ||
        want.privateIpAddress === have.privateIpAddress)
    );
  });

export const InboundEndpointProvider = () =>
  Provider.succeed(InboundEndpoint, {
    stables: [
      "inboundEndpointName",
      "inboundEndpointId",
      "dnsResolver",
      "resourceGroup",
      "location",
      "ipConfigurations",
      "privateIpAddresses",
      "resourceGuid",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resolvers = yield* dnsresolver
        .ListDnsResolvers({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListDnsResolvers", page)),
        );
      const found: InboundEndpoint["Attributes"][] = [];
      for (const resolver of resolvers.value ?? []) {
        const group = resourceGroupOf(resolver.id);
        if (group === undefined || resolver.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          dnsresolver.ListInboundEndpoints({
            subscriptionId,
            resourceGroupName: group,
            dnsResolverName: resolver.name,
          }),
        );
        if (page !== undefined) {
          yield* requireSinglePage("ListInboundEndpoints", page);
        }
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
      const sameParent =
        sameArm(news.resourceGroup, output.resourceGroup) &&
        sameArm(news.dnsResolver, output.dnsResolver);
      const sameConfig = sameIpConfigurations(
        news.ipConfigurations,
        output.ipConfigurations,
      );
      if (
        !sameParent ||
        (news.name !== undefined && news.name !== output.inboundEndpointName) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameConfig
      ) {
        // A delegated subnet holds a single endpoint: when the new endpoint
        // reuses a subnet of the old one, the old one must go first.
        const reusesSubnet = news.ipConfigurations.some((want) =>
          output.ipConfigurations.some((have) =>
            sameArm(have.subnetId, want.subnetId),
          ),
        );
        return { action: "replace", deleteFirst: reusesSubnet } as const;
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
      const name =
        output?.inboundEndpointName ??
        olds?.name ??
        (yield* createDnsResolverName(id));
      const observed = yield* getEndpoint(
        subscriptionId,
        resourceGroup,
        dnsResolverName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, dnsResolverName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const { resourceGroup, dnsResolver: dnsResolverName } = news;
      const name =
        news.name ??
        output?.inboundEndpointName ??
        (yield* createDnsResolverName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        dnsResolverName,
        inboundEndpointName: name,
      };
      const get = getEndpoint(
        subscriptionId,
        resourceGroup,
        dnsResolverName,
        name,
      );
      const label = `DNS resolver inbound endpoint ${name}`;

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
        yield* dnsresolver.InboundEndpointsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            ipConfigurations: news.ipConfigurations.map((config) => ({
              subnet: { id: config.subnetId },
              privateIpAllocationMethod:
                config.privateIpAllocationMethod ?? "Dynamic",
              privateIpAddress: config.privateIpAddress,
            })),
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (endpoint) => endpoint.properties.provisioningState,
        ENDPOINT_BUDGET,
      );

      // Sync tags (IP configurations are immutable; diff replaces).
      if (tagsDiffer(observed.tags, tags)) {
        yield* dnsresolver.UpdateInboundEndpoint({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (endpoint) =>
            tagsDiffer(endpoint.tags, tags)
              ? "Updating"
              : endpoint.properties.provisioningState,
          ENDPOINT_BUDGET,
        );
      }

      return toAttrs(resourceGroup, dnsResolverName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        dnsresolver.DeleteInboundEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          dnsResolverName: output.dnsResolver,
          inboundEndpointName: output.inboundEndpointName,
        }),
      );
      yield* waitUntilGone(
        `DNS resolver inbound endpoint ${output.inboundEndpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.dnsResolver,
          output.inboundEndpointName,
        ),
        ENDPOINT_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.DnsResolver.DnsResolver",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
