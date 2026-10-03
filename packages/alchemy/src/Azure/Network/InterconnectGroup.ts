import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { lower } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

/** Subgroup profile of an interconnect group. */
export interface InterconnectGroupSubgroupProfile {
  /** VM size the subgroups host, e.g. `"Standard_ND96isr_H100_v5"`. */
  vmSize: string;
  /** Interconnect scope of each subgroup. */
  scope?: "None" | "InfiniBand";
  /** Size (number of VMs) of each subgroup. */
  size?: number;
}

export interface InterconnectGroupProps {
  /** Resource group of the group. Changing it replaces the group. */
  resourceGroup: string;
  /**
   * Name of the group: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Interconnect scope of the group. Changing it replaces the group.
   * @default "InfiniBand"
   */
  scope?: "None" | "InfiniBand";
  /**
   * Subgroup profile. Changing `vmSize` replaces the group; `size` and
   * `scope` update in place.
   */
  subgroupProfile: InterconnectGroupSubgroupProfile;
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface InterconnectGroup extends Resource<
  "Azure.Network.InterconnectGroup",
  InterconnectGroupProps,
  {
    /** Name of the group. */
    interconnectGroupName: string;
    /** ARM resource ID of the group. */
    interconnectGroupId: string;
    /** Resource group of the group. */
    resourceGroup: string;
    /** Location of the group. */
    location: string;
    /** Interconnect scope. */
    scope: string | undefined;
    /** VM size of the subgroups. */
    vmSize: string | undefined;
    /** IDs of the subgroups Azure allocated. */
    subgroupIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure interconnect group (preview) — a reservation of
 * high-bandwidth (InfiniBand) interconnect capacity for a VM size, split
 * into subgroups that GPU clusters are placed into. Requires dedicated
 * capacity on the subscription.
 *
 * @see https://learn.microsoft.com/rest/api/virtualnetwork/interconnect-groups
 *
 * ### Creating an Interconnect Group
 * **Example:** InfiniBand group for H100 VMs
 * ```typescript
 * const interconnect = yield* Azure.Network.InterconnectGroup("gpu", {
 *   resourceGroup: group.resourceGroupName,
 *   scope: "InfiniBand",
 *   subgroupProfile: {
 *     vmSize: "Standard_ND96isr_H100_v5",
 *     scope: "InfiniBand",
 *     size: 16,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const InterconnectGroup = Resource<InterconnectGroup>(
  "Azure.Network.InterconnectGroup",
);

export const InterconnectGroupProvider = () =>
  Provider.succeed(
    InterconnectGroup,
    networkProvider<InterconnectGroup>()({
      label: "interconnect group",
      nameAttr: "interconnectGroupName",
      tracked: true,
      immutable: (news, output) =>
        lower(news.scope ?? "InfiniBand") !== lower(output.scope) ||
        lower(news.subgroupProfile.vmSize) !== lower(output.vmSize),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetInterconnectGroup({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            interconnectGroupName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.InterconnectGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          interconnectGroupName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteInterconnectGroup({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          interconnectGroupName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateInterconnectGroupTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          interconnectGroupName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListInterconnectGroupAll({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          scope: news.scope ?? "InfiniBand",
          subgroupProfile: news.subgroupProfile,
        },
      }),
      drifted: (observed, _body, news) =>
        (news.subgroupProfile.size !== undefined &&
          observed.properties?.subgroupProfile?.size !==
            news.subgroupProfile.size) ||
        (news.subgroupProfile.scope !== undefined &&
          lower(observed.properties?.subgroupProfile?.scope) !==
            lower(news.subgroupProfile.scope)),
      toAttrs: (path, observed) => ({
        interconnectGroupName: path.name,
        interconnectGroupId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        scope: observed.properties?.scope,
        vmSize: observed.properties?.subgroupProfile?.vmSize,
        subgroupIds: idsOf(observed.properties?.subgroups),
        tags: userTags(observed.tags),
      }),
    }),
  );
