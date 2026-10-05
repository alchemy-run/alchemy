import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface IpGroupProps {
  /** Resource group of the IP group. Changing it replaces the IP group. */
  resourceGroup: string;
  /**
   * Name of the IP group: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the IP group.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the IP group.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** IP addresses, ranges, and CIDRs, e.g. `["10.0.0.0/24", "10.1.0.4"]`. */
  ipAddresses?: string[];
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface IpGroup extends Resource<
  "Azure.Network.IpGroup",
  IpGroupProps,
  {
    /** Name of the IP group. */
    ipGroupName: string;
    /** ARM resource ID of the IP group. */
    ipGroupId: string;
    /** Resource group of the IP group. */
    resourceGroup: string;
    /** Location of the IP group. */
    location: string;
    /** IP addresses, ranges, and CIDRs in the group. */
    ipAddresses: string[];
    /** IDs of the firewalls that reference the group. */
    firewallIds: string[];
    /** IDs of the firewall policies that reference the group. */
    firewallPolicyIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure IP group — a named, reusable set of IP addresses, ranges, and
 * CIDRs referenced by Azure Firewall and firewall policy rules. IP groups
 * are free.
 *
 * @see https://learn.microsoft.com/azure/firewall/ip-groups
 *
 * ### Creating an IP Group
 * **Example:** On-premises ranges
 * ```typescript
 * const onPrem = yield* Azure.Network.IpGroup("on-prem", {
 *   resourceGroup: group.resourceGroupName,
 *   ipAddresses: ["10.10.0.0/16", "192.168.1.0/24"],
 * });
 * ```
 *
 * @resource
 */
export const IpGroup = Resource<IpGroup>("Azure.Network.IpGroup");

const ids = (items: ReadonlyArray<{ id?: string }> | undefined) =>
  (items ?? []).flatMap((item) => (item.id === undefined ? [] : [item.id]));

export const IpGroupProvider = () =>
  Provider.succeed(
    IpGroup,
    networkProvider<IpGroup>()({
      label: "IP group",
      nameAttr: "ipGroupName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetIpGroup({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            ipGroupsName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.IpGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ipGroupsName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteIpGroup({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ipGroupsName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateIpGroupGroups({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          ipGroupsName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListIpGroups({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: { ipAddresses: news.ipAddresses ?? [] },
      }),
      drifted: (observed, _body, news) =>
        !sameSet(observed.properties?.ipAddresses, news.ipAddresses),
      toAttrs: (path, observed) => ({
        ipGroupName: path.name,
        ipGroupId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        ipAddresses: [...(observed.properties?.ipAddresses ?? [])],
        firewallIds: ids(observed.properties?.firewalls),
        firewallPolicyIds: ids(observed.properties?.firewallPolicies),
        tags: userTags(observed.tags),
      }),
    }),
  );
