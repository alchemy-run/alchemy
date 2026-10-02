import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import {
  networkManagerChildName,
  networkManagerTags,
} from "./networkManagerShared.ts";

export interface NetworkGroupProps {
  /** Resource group of the network manager. Changing it replaces the group. */
  resourceGroup: string;
  /** Name of the parent network manager. Changing it replaces the group. */
  networkManager: string;
  /**
   * Name of the network group. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the group.
   */
  name?: string;
  /** Description of the group. */
  description?: string;
  /**
   * Kind of members. Changing it replaces the group.
   * @default "VirtualNetwork"
   */
  memberType?: "VirtualNetwork" | "Subnet";
}

export interface NetworkGroup extends Resource<
  "Azure.Network.NetworkGroup",
  NetworkGroupProps,
  {
    /** Name of the network group. */
    networkGroupName: string;
    /** ARM resource ID of the network group. */
    networkGroupId: string;
    /** Name of the parent network manager. */
    networkManager: string;
    /** Resource group of the network manager. */
    resourceGroup: string;
    /** Description. */
    description: string | undefined;
    /** Kind of members. */
    memberType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A network group in an Azure Virtual Network Manager — a set of virtual
 * networks (or subnets) that connectivity and security admin
 * configurations target. Add members with {@link NetworkGroupStaticMember}
 * (or Azure Policy for dynamic membership). Network groups carry no tags:
 * ownership follows the parent network manager.
 *
 * @see https://learn.microsoft.com/azure/virtual-network-manager/concept-network-groups
 *
 * ### Creating a Network Group
 * **Example:** Group of spoke VNets
 * ```typescript
 * const spokes = yield* Azure.Network.NetworkGroup("spokes", {
 *   resourceGroup: group.resourceGroupName,
 *   networkManager: manager.networkManagerName,
 *   description: "Production spokes",
 * });
 * ```
 *
 * @resource
 */
export const NetworkGroup = Resource<NetworkGroup>(
  "Azure.Network.NetworkGroup",
);

export const NetworkGroupProvider = () =>
  Provider.succeed(
    NetworkGroup,
    networkProvider<NetworkGroup>()({
      label: "network group",
      nameAttr: "networkGroupName",
      parents: ["networkManager"],
      tracked: false,
      physicalName: networkManagerChildName,
      immutable: (news, output) =>
        (news.memberType ?? "VirtualNetwork") !==
        (output.memberType ?? "VirtualNetwork"),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkGroup({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkManagerName: path.networkManager!,
            networkGroupName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          networkGroupName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkGroup({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkManagerName: path.networkManager!,
          networkGroupName: path.name,
          force: true,
        }),
      ownerTags: networkManagerTags,
      body: (news) => ({
        properties: {
          description: news.description,
          memberType: news.memberType,
        },
      }),
      drifted: (observed, _body, news) =>
        (observed.properties?.description ?? undefined) !== news.description,
      toAttrs: (path, observed) => ({
        networkGroupName: path.name,
        networkGroupId: observed.id ?? "",
        networkManager: path.networkManager!,
        resourceGroup: path.resourceGroup,
        description: observed.properties?.description,
        memberType: observed.properties?.memberType,
      }),
      dependsOn: ["Azure.Network.NetworkManager"],
    }),
  );
