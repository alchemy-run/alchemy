import * as mission from "@distilled.cloud/azure/mission";
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
  changedProperties,
  createMissionName,
  FAST,
  getCommunity,
  NAMESPACE,
  sameName,
} from "./Common.ts";

/** One egress rule from the community to an external destination. */
export interface CommunityEndpointRule {
  /**
   * Rule name.
   * @default not set
   */
  endpointRuleName?: string;
  /**
   * Destination: an FQDN, FQDN tag, IP address/CIDR, private network or service tag.
   * @default not set
   */
  destination?: string;
  /**
   * Kind of destination.
   * @default not set
   */
  destinationType?: "FQDN" | "FQDNTag" | "IPAddress" | "PrivateNetwork" | "ServiceTag";
  /**
   * Protocols, e.g. `["TCP"]` or `["HTTPS"]`.
   * @default not set
   */
  protocols?: ("ANY" | "TCP" | "UDP" | "ICMP" | "ESP" | "AH" | "HTTPS" | "HTTP")[];
  /**
   * Ports, e.g. `"443"` or `"8000-8080"`.
   * @default not set
   */
  ports?: string;
  /**
   * ARM ID of the transit hub the traffic leaves through, if any.
   * @default not set
   */
  transitHubResourceId?: string;
}

export interface CommunityEndpointProps {
  /**
   * Resource group of the community. Changing it replaces the endpoint.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the parent community. Changing it replaces the endpoint. */
  community: string;
  /**
   * Endpoint name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the endpoint.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location of the endpoint. Changing it replaces the endpoint.
   * @default the community's location
   */
  location?: string;
  /** Egress rules programmed into the community firewall. */
  ruleCollection: CommunityEndpointRule[];
  /**
   * Whether rule updates apply `Automatic`ally or need `Manual` approval.
   * @default not set
   */
  updateMode?: "Automatic" | "Manual";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface CommunityEndpoint extends Resource<
  "Azure.VirtualEnclaves.CommunityEndpoint",
  CommunityEndpointProps,
  {
    /** Name of the endpoint. */
    communityEndpointName: string;
    /** ARM resource ID of the endpoint; pass it as a connection's destination. */
    communityEndpointId: string;
    /** Name of the parent community. */
    community: string;
    /** Resource group of the community. */
    resourceGroup: string;
    /** Location of the endpoint. */
    location: string;
    /** ARM IDs of the resources the endpoint manages. */
    resourceCollection: string[];
    /** Last provisioning state. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A community endpoint (`Microsoft.Mission/communities/communityEndpoints`)
 * — firewall egress rules from an Azure Virtual Enclaves {@link Community}
 * to an external destination. Enclave connections can target it.
 *
 * :::caution
 * Changing `community`, `name`, `location`, or `resourceGroup` replaces the
 * community endpoint.
 * :::
 *
 * @see https://learn.microsoft.com/azure/virtual-enclaves/overview
 *
 * ### Creating a Community Endpoint
 * **Example:** Allow HTTPS egress to an FQDN
 * ```typescript
 * const community = yield* Azure.VirtualEnclaves.Community("hub", {
 *   addressSpace: "10.0.0.0/16",
 *   firewallSku: "Basic",
 * });
 * const endpoint = yield* Azure.VirtualEnclaves.CommunityEndpoint("egress", {
 *   community: community.communityName,
 *   ruleCollection: [
 *     {
 *       endpointRuleName: "github",
 *       destination: "github.com",
 *       destinationType: "FQDN",
 *       protocols: ["HTTPS"],
 *       ports: "443",
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const CommunityEndpoint = GroupedResource<CommunityEndpoint>(
  "Azure.VirtualEnclaves.CommunityEndpoint",
);

type Observed = mission.GetCommunityEndpointResponse | mission.CommunityEndpointResource;

const getEndpoint = (
  subscriptionId: string,
  resourceGroupName: string,
  communityName: string,
  communityEndpointName: string,
) =>
  orUndefinedIfNotFound(
    mission.GetCommunityEndpoint({
      subscriptionId,
      resourceGroupName,
      communityName,
      communityEndpointName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  community: string,
  name: string,
  observed: Observed,
): CommunityEndpoint["Attributes"] => ({
  communityEndpointName: name,
  communityEndpointId: observed.id ?? "",
  community,
  resourceGroup,
  location: observed.location,
  resourceCollection: observed.properties?.resourceCollection ?? [],
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

export const CommunityEndpointProvider = () =>
  Provider.succeed(CommunityEndpoint, {
    stables: [
      "communityEndpointName",
      "communityEndpointId",
      "community",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const communities = yield* collectAll(mission.ListCommunityBySubscription, {
        subscriptionId,
      });
      const results: CommunityEndpoint["Attributes"][] = [];
      for (const community of communities.value) {
        const group = resourceGroupOf(community.id);
        if (group === undefined || community.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          collectAll(mission.ListCommunityEndpointByCommunityResource, {
            subscriptionId,
            resourceGroupName: group,
            communityName: community.name,
          }),
        );
        if (page === undefined) continue;
        for (const endpoint of page.value) {
          if (hasAnyAlchemyTag(endpoint.tags) && endpoint.name !== undefined) {
            results.push(toAttrs(group, community.name, endpoint.name, endpoint));
          }
        }
      }
      return results;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.community, output.community) ||
        (news.name !== undefined && !sameName(news.name, output.communityEndpointName)) ||
        (news.location !== undefined && !sameName(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const community = output?.community ?? olds?.community;
      if (resourceGroup === undefined || community === undefined) {
        return undefined;
      }
      const name = output?.communityEndpointName ?? olds?.name ?? (yield* createMissionName(id));
      const observed = yield* getEndpoint(subscriptionId, resourceGroup, community, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, community, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, community } = news;
      const name = news.name ?? output?.communityEndpointName ?? (yield* createMissionName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        communityName: community,
        communityEndpointName: name,
      };
      const desired = {
        ruleCollection: news.ruleCollection,
        updateMode: news.updateMode,
      };
      const get = getEndpoint(subscriptionId, resourceGroup, community, name);
      const waitReady = waitForProvisioned(
        `community endpoint ${name}`,
        get,
        (endpoint) => endpoint.properties?.provisioningState,
        FAST,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const parent = news.location
          ? undefined
          : yield* getCommunity(subscriptionId, resourceGroup, community);
        yield* mission.CommunityEndpointsCreateOrUpdate({
          ...where,
          location: news.location ?? output?.location ?? parent?.location ?? env.location,
          tags,
          properties: desired,
        });
      }
      observed = yield* waitReady;

      // Sync rules and tags; PATCH only the deltas.
      const properties = changedProperties(desired, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (properties !== undefined || tagsChanged) {
        yield* mission.UpdateCommunityEndpoint({
          ...where,
          properties,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, community, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        mission.DeleteCommunityEndpoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          communityName: output.community,
          communityEndpointName: output.communityEndpointName,
        }),
      );
      yield* waitUntilGone(
        `community endpoint ${output.communityEndpointName}`,
        getEndpoint(
          subscriptionId,
          output.resourceGroup,
          output.community,
          output.communityEndpointName,
        ),
        FAST,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.VirtualEnclaves.Community",
        "Azure.VirtualEnclaves.TransitHub",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
