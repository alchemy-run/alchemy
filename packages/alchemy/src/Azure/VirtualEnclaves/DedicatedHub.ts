import * as mission from "@distilled.cloud/azure/mission";
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
  changedProperties,
  createMissionName,
  getCommunity,
  NAMESPACE,
  sameName,
  SLOW,
} from "./Common.ts";

export interface DedicatedHubProps {
  /** Resource group of the community. Changing it replaces the hub. */
  resourceGroup: string;
  /** Name of the parent community. Changing it replaces the hub. */
  community: string;
  /**
   * Dedicated hub name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the hub.
   */
  name?: string;
  /**
   * Azure location of the hub. Changing it replaces the hub.
   * @default the community's location
   */
  location?: string;
  /**
   * Whether the hub is shared by enclaves (`Pooled`) or reserved for
   * specific enclaves (`Reserved`).
   */
  designation?: "Pooled" | "Reserved";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DedicatedHub extends Resource<
  "Azure.VirtualEnclaves.DedicatedHub",
  DedicatedHubProps,
  {
    /** Name of the dedicated hub. */
    dedicatedHubName: string;
    /** ARM resource ID of the hub; pass it as an enclave's `dedicatedHubId`. */
    dedicatedHubId: string;
    /** Name of the parent community. */
    community: string;
    /** Resource group of the community. */
    resourceGroup: string;
    /** Location of the hub. */
    location: string;
    /** Designation of the hub. */
    designation: string | undefined;
    /** ARM ID of the hub's Virtual WAN hub. */
    vHubResourceId: string | undefined;
    /** ARM ID of the hub's Azure Firewall. */
    firewallResourceId: string | undefined;
    /** ARM ID of the hub's firewall policy. */
    firewallPolicyResourceId: string | undefined;
    /** Last provisioning state. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dedicated hub — an additional Virtual WAN hub and Azure Firewall
 * allocated inside an Azure Virtual Enclaves {@link Community}. Enclaves
 * attach to it with `dedicatedHubId`. The hub and firewall bill hourly and
 * take 30+ minutes to provision.
 *
 * @see https://learn.microsoft.com/azure/virtual-enclaves/overview
 *
 * ### Creating a Dedicated Hub
 * **Example:** Reserved hub for a sensitive enclave
 * ```typescript
 * const hub = yield* Azure.VirtualEnclaves.DedicatedHub("reserved", {
 *   resourceGroup: group.resourceGroupName,
 *   community: community.communityName,
 *   designation: "Reserved",
 * });
 * const enclave = yield* Azure.VirtualEnclaves.VirtualEnclave("spoke", {
 *   resourceGroup: group.resourceGroupName,
 *   communityId: community.communityId,
 *   dedicatedHubId: hub.dedicatedHubId,
 *   enclaveVirtualNetwork: { networkSize: "small" },
 * });
 * ```
 *
 * @resource
 */
export const DedicatedHub = Resource<DedicatedHub>(
  "Azure.VirtualEnclaves.DedicatedHub",
);

type Observed = mission.GetDedicatedHubResponse | mission.DedicatedHubResource;

const getDedicatedHub = (
  subscriptionId: string,
  resourceGroupName: string,
  communityName: string,
  dedicatedHubName: string,
) =>
  orUndefinedIfNotFound(
    mission.GetDedicatedHub({
      subscriptionId,
      resourceGroupName,
      communityName,
      dedicatedHubName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  community: string,
  name: string,
  observed: Observed,
): DedicatedHub["Attributes"] => ({
  dedicatedHubName: name,
  dedicatedHubId: observed.id ?? "",
  community,
  resourceGroup,
  location: observed.location,
  designation: observed.properties?.designation,
  vHubResourceId: observed.properties?.vHubResourceId,
  firewallResourceId: observed.properties?.firewallResourceId,
  firewallPolicyResourceId: observed.properties?.firewallPolicyResourceId,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

export const DedicatedHubProvider = () =>
  Provider.succeed(DedicatedHub, {
    stables: [
      "dedicatedHubName",
      "dedicatedHubId",
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
      const results: DedicatedHub["Attributes"][] = [];
      for (const community of communities.value) {
        const group = resourceGroupOf(community.id);
        if (group === undefined || community.name === undefined) continue;
        const page = yield* orUndefinedIfNotFound(
          mission.ListDedicatedHubByCommunityResource({
            subscriptionId,
            resourceGroupName: group,
            communityName: community.name,
          }),
        );
        if (page === undefined) continue;
        yield* requireSinglePage("ListDedicatedHubByCommunityResource", page);
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
          !sameName(news.name, output.dedicatedHubName)) ||
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
        output?.dedicatedHubName ??
        olds?.name ??
        (yield* createMissionName(id));
      const observed = yield* getDedicatedHub(
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
        news.name ?? output?.dedicatedHubName ?? (yield* createMissionName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        communityName: community,
        dedicatedHubName: name,
      };
      const desired = { designation: news.designation };
      const get = getDedicatedHub(
        subscriptionId,
        resourceGroup,
        community,
        name,
      );
      const waitReady = waitForProvisioned(
        `dedicated hub ${name}`,
        get,
        (hub) => hub.properties?.provisioningState,
        SLOW,
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Deploys a vWAN hub and firewall (long-running).
      if (observed === undefined) {
        const parent = news.location
          ? undefined
          : yield* getCommunity(subscriptionId, resourceGroup, community);
        yield* mission.DedicatedHubCreateOrUpdate({
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

      // Sync designation and tags; PATCH only the deltas.
      const properties = changedProperties(desired, observed.properties);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (properties !== undefined || tagsChanged) {
        yield* mission.UpdateDedicatedHub({
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
        mission.DeleteDedicatedHub({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          communityName: output.community,
          dedicatedHubName: output.dedicatedHubName,
        }),
      );
      yield* waitUntilGone(
        `dedicated hub ${output.dedicatedHubName}`,
        getDedicatedHub(
          subscriptionId,
          output.resourceGroup,
          output.community,
          output.dedicatedHubName,
        ),
        SLOW,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.VirtualEnclaves.Community",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
