import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";
import {
  networkManagerChildName,
  networkManagerTags,
} from "./networkManagerShared.ts";

export interface NetworkGroupStaticMemberProps {
  /** Resource group of the network manager. Changing it replaces the member. */
  resourceGroup: string;
  /** Name of the network manager. Changing it replaces the member. */
  networkManager: string;
  /** Name of the parent network group. Changing it replaces the member. */
  networkGroup: string;
  /**
   * Name of the static member. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the member.
   */
  name?: string;
  /**
   * ARM ID of the member virtual network (or subnet, for `Subnet`
   * groups). Changing it replaces the member.
   */
  resourceId: string;
}

export interface NetworkGroupStaticMember extends Resource<
  "Azure.Network.NetworkGroupStaticMember",
  NetworkGroupStaticMemberProps,
  {
    /** Name of the static member. */
    staticMemberName: string;
    /** ARM resource ID of the static member. */
    staticMemberId: string;
    /** Name of the network manager. */
    networkManager: string;
    /** Name of the parent network group. */
    networkGroup: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** ARM ID of the member resource. */
    resourceId: string | undefined;
    /** Region of the member resource. */
    region: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A static member of an Azure Virtual Network Manager network group — one
 * virtual network explicitly added to the group. Static members carry no
 * tags: ownership follows the network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-network-groups#static-membership
 *
 * ### Adding a Member
 * **Example:** Add a VNet to a network group
 * ```typescript
 * yield* Azure.Network.NetworkGroupStaticMember("spoke1", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   networkGroup: spokes.networkGroupName,
 *   resourceId: vnet.virtualNetworkId,
 * });
 * ```
 *
 * @resource
 */
export const NetworkGroupStaticMember = Resource<NetworkGroupStaticMember>(
  "Azure.Network.NetworkGroupStaticMember",
);

export const NetworkGroupStaticMemberProvider = () =>
  Provider.succeed(
    NetworkGroupStaticMember,
    networkProvider<NetworkGroupStaticMember>()({
      label: "network group static member",
      nameAttr: "staticMemberName",
      parents: ["networkManager", "networkGroup"],
      tracked: false,
      physicalName: networkManagerChildName,
      immutable: (news, output) => !sameId(news.resourceId, output.resourceId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetStaticMember({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            networkGroupName: path.networkGroup!,
            staticMemberName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.StaticMembersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          networkGroupName: path.networkGroup!,
          staticMemberName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteStaticMember({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          networkGroupName: path.networkGroup!,
          staticMemberName: path.name,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({ properties: { resourceId: news.resourceId } }),
      toAttrs: (path, observed) => ({
        staticMemberName: path.name,
        staticMemberId: observed.id ?? "",
        networkManager: path.networkManager!,
        networkGroup: path.networkGroup!,
        resourceGroup: path.resourceGroup,
        resourceId: observed.properties?.resourceId,
        region: observed.properties?.region,
      }),
      dependsOn: ["Azure.Network.NetworkGroup", "Azure.Network.NetworkManager"],
    }),
  );
