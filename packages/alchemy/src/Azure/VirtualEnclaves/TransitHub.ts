import * as mission from "@distilled.cloud/azure/mission";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  changedProperties,
  createMissionName,
  getCommunity,
  NAMESPACE,
  sameName,
  SLOW,
} from "./Common.ts";

/** How the transit hub connects the community to external networks. */
export interface TransitHubOption {
  /** Connection type: `ExpressRoute`, `Gateway` (VPN) or `Peering`. */
  type?: "ExpressRoute" | "Gateway" | "Peering";
  /** Scale units of the gateway. */
  scaleUnits?: number;
  /** ARM ID of the remote virtual network (for `Peering`). */
  remoteVirtualNetworkId?: string;
}

export interface TransitHubProps {
  /** Resource group of the community. Changing it replaces the transit hub. */
  resourceGroup: string;
  /** Name of the parent community. Changing it replaces the transit hub. */
  community: string;
  /**
   * Transit hub name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the transit hub.
   */
  name?: string;
  /**
   * Azure location of the transit hub. Changing it replaces the transit hub.
   * @default the community's location
   */
  location?: string;
  /** Requested state, e.g. `"PendingApproval"` or `"Approved"`. */
  state?:
    | "PendingApproval"
    | "Approved"
    | "PendingUpdate"
    | "Active"
    | "Failed";
  /** How the hub connects to external networks. */
  transitOption?: TransitHubOption;
  /** Security provider inspecting transit traffic: `None` or `AzureFirewall`. */
  securityProvider?: "None" | "AzureFirewall";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface TransitHub extends Resource<
  "Azure.VirtualEnclaves.TransitHub",
  TransitHubProps,
  {
    /** Name of the transit hub. */
    transitHubName: string;
    /** ARM resource ID of the transit hub. */
    transitHubId: string;
    /** Name of the parent community. */
    community: string;
    /** Resource group of the community. */
    resourceGroup: string;
    /** Location of the transit hub. */
    location: string;
    /** Observed state of the transit hub. */
    state: string | undefined;
    /** ARM IDs of the resources the transit hub manages. */
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
 * A transit hub — connects an Azure Virtual Enclaves {@link Community} to
 * on-premises or external networks over ExpressRoute, a VPN gateway, or
 * VNet peering. Gateways bill hourly.
 *
 * @see https://learn.microsoft.com/azure/virtual-enclaves/overview
 *
 * ### Creating a Transit Hub
 * **Example:** Peer the community with an external virtual network
 * ```typescript
 * const transit = yield* Azure.VirtualEnclaves.TransitHub("transit", {
 *   resourceGroup: group.resourceGroupName,
 *   community: community.communityName,
 *   transitOption: {
 *     type: "Peering",
 *     remoteVirtualNetworkId: network.virtualNetworkId,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const TransitHub = Resource<TransitHub>(
  "Azure.VirtualEnclaves.TransitHub",
);

type Observed = mission.GetTransitHubResponse | mission.TransitHubResource;

const getTransitHub = (
  subscriptionId: string,
  resourceGroupName: string,
  communityName: string,
  transitHubName: string,
) =>
  orUndefinedIfNotFound(
    mission.GetTransitHub({
      subscriptionId,
      resourceGroupName,
      communityName,
      transitHubName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  community: string,
  name: string,
  observed: Observed,
): TransitHub["Attributes"] => ({
  transitHubName: name,
  transitHubId: observed.id ?? "",
  community,
  resourceGroup,
  location: observed.location,
  state: observed.properties?.state,
  resourceCollection: observed.properties?.resourceCollection ?? [],
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

export const TransitHubProvider = () =>
  Provider.succeed(TransitHub, {
    stables: [
      "transitHubName",
      "transitHubId",
      "community",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const communities = yield* mission
        .ListCommunityBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListCommunityBySubscription", page),
          ),
        );
      const results: TransitHub["Attributes"][] = [];
      for (const community of communities.value) {
        const group = resourceGroupOf(community.id);
        if (group === undefined || community.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          mission.ListTransitHubByCommunityResource({
            subscriptionId,
            resourceGroupName: group,
            communityName: community.name,
          }),
        );
        if (page === undefined) continue;
        yield* requireSinglePage("ListTransitHubByCommunityResource", page);
        for (const hub of page.value) {
          if (hasAnyAlchemyTag(hub.tags) && hub.name !== undefined) {
            results.push(toAttrs(group, community.name, hub.name, hub));
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
        (news.name !== undefined &&
          !sameName(news.name, output.transitHubName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location))
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
      const name =
        output?.transitHubName ?? olds?.name ?? (yield* createMissionName(id));
      const observed = yield* getTransitHub(
        subscriptionId,
        resourceGroup,
        community,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, community, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, community } = news;
      const name =
        news.name ?? output?.transitHubName ?? (yield* createMissionName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        communityName: community,
        transitHubName: name,
      };
      const option = news.transitOption;
      const desired = {
        state: news.state,
        transitOption:
          option === undefined
            ? undefined
            : {
                type: option.type,
                params:
                  option.scaleUnits === undefined &&
                  option.remoteVirtualNetworkId === undefined
                    ? undefined
                    : {
                        scaleUnits: option.scaleUnits,
                        remoteVirtualNetworkId: option.remoteVirtualNetworkId,
                      },
              },
        securityProvider: news.securityProvider,
      };
      const get = getTransitHub(subscriptionId, resourceGroup, community, name);
      // Gateways (ExpressRoute / VPN) take tens of minutes.
      const waitReady = waitForProvisioned(
        `transit hub ${name}`,
        get,
        (hub) => hub.properties?.provisioningState,
        SLOW,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. A hub whose last provisioning failed is re-PUT.
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed"
      ) {
        const parent = news.location
          ? undefined
          : yield* getCommunity(subscriptionId, resourceGroup, community);
        yield* mission.TransitHubCreateOrUpdate({
          ...where,
          location:
            news.location ??
            output?.location ??
            parent?.location ??
            env.location,
          tags,
          properties: desired,
        });
      }
      observed = yield* waitReady;

      // Sync settings and tags against observed state. Like dedicated
      // hubs, a PATCH of a community hub's tags is accepted but not
      // applied, so the delta is sent as a full PUT.
      const properties = changedProperties(desired, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (properties !== undefined || tagsChanged) {
        const current = observed.properties;
        yield* mission
          .TransitHubCreateOrUpdate({
            ...where,
            location: observed.location,
            tags,
            properties: {
              state: desired.state ?? current?.state,
              transitOption: desired.transitOption ?? current?.transitOption,
              securityProvider:
                desired.securityProvider ?? current?.securityProvider,
            },
          })
          // The create's ARM operation can outlive the `Succeeded` state.
          .pipe(
            Effect.retry({
              while: (e) => e._tag === "HybridNetworkOperationInProgress",
              schedule: Schedule.spaced("30 seconds"),
              times: 60,
            }),
          );
        // The PUT is applied asynchronously and the hub may still report
        // its previous `Succeeded` state; wait until the tags are visible.
        observed = yield* waitForProvisioned(
          `transit hub ${name}`,
          get,
          (hub) => {
            const state = hub.properties?.provisioningState;
            return tagsDiffer(hub.tags, tags) &&
              (state === undefined || state === "Succeeded")
              ? "Updating"
              : state;
          },
          { interval: "30 seconds", times: 40 },
        );
      }

      return toAttrs(resourceGroup, community, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const get = getTransitHub(
        subscriptionId,
        output.resourceGroup,
        output.community,
        output.transitHubName,
      );
      // A DELETE accepted while a failed create is still settling can be
      // dropped: the hub stays in its old state. Re-issue it each round
      // unless the hub is already deleting.
      const deleteRound = Effect.gen(function* () {
        const observed = yield* get;
        if (observed === undefined) return;
        if (observed.properties?.provisioningState !== "Deleting") {
          yield* ignoreNotFound(
            mission.DeleteTransitHub({
              subscriptionId,
              resourceGroupName: output.resourceGroup,
              communityName: output.community,
              transitHubName: output.transitHubName,
            }),
          );
        }
        yield* waitUntilGone(`transit hub ${output.transitHubName}`, get, {
          interval: "30 seconds",
          times: 30,
        });
      });
      yield* deleteRound.pipe(
        Effect.retry({
          while: (e) => e._tag === "Azure.DeleteTimedOut",
          times: 4,
        }),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.VirtualEnclaves.Community",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
