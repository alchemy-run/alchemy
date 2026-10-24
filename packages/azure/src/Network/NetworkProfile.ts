import * as network from "@distilled.cloud/azure/network";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { canonical, lower } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

/** A container network interface template of a network profile. */
export interface ContainerNetworkInterfaceConfiguration {
  /** Name of the configuration. */
  name: string;
  /** IP configurations of the interface: each places it in one subnet. */
  ipConfigurations: {
    /** Name of the IP configuration. */
    name: string;
    /**
     * ARM ID of the subnet, delegated to
     * `Microsoft.ContainerInstance/containerGroups`.
     */
    subnetId: string;
  }[];
}

export interface NetworkProfileProps {
  /** Resource group of the profile. Changing it replaces the profile. */
  resourceGroup: string;
  /**
   * Name of the profile: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the profile.
   */
  name?: string;
  /**
   * Azure location (the virtual network's). Changing it replaces the
   * profile.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Container network interface templates (usually one). */
  containerNetworkInterfaceConfigurations: ContainerNetworkInterfaceConfiguration[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface NetworkProfile extends Resource<
  "Azure.Network.NetworkProfile",
  NetworkProfileProps,
  {
    /** Name of the profile. */
    networkProfileName: string;
    /** ARM resource ID of the profile. */
    networkProfileId: string;
    /** Resource group of the profile. */
    resourceGroup: string;
    /** Location of the profile. */
    location: string;
    /** IDs of the container network interfaces created from the profile. */
    containerNetworkInterfaceIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure network profile (`Microsoft.Network/networkProfiles`) — a
 * template that places container network interfaces in a subnet delegated
 * to `Microsoft.ContainerInstance/containerGroups`, used to deploy
 * container groups into a virtual network. Profiles are free.
 *
 * @see https://learn.microsoft.com/azure/container-instances/container-instances-virtual-network-concepts
 *
 * ### Creating a Network Profile
 * **Example:** Profile for container groups in a delegated subnet
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("aci", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   delegations: [{ serviceName: "Microsoft.ContainerInstance/containerGroups" }],
 * });
 * const profile = yield* Azure.Network.NetworkProfile("aci-profile", {
 *   containerNetworkInterfaceConfigurations: [
 *     { name: "eth0", ipConfigurations: [{ name: "ipconfig", subnetId: subnet.subnetId }] },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const NetworkProfile = GroupedResource<NetworkProfile>("Azure.Network.NetworkProfile");

/** Comparable projection of interface configurations (names + subnet IDs). */
const projectConfigurations = (
  configurations: ReadonlyArray<{
    readonly name?: string;
    readonly ipConfigurations: ReadonlyArray<{
      readonly name?: string;
      readonly subnetId?: string;
    }>;
  }>,
) =>
  canonical(
    [...configurations]
      .map((c) => ({
        name: lower(c.name),
        ipConfigurations: [...c.ipConfigurations]
          .map((ip) => ({ name: lower(ip.name), subnetId: lower(ip.subnetId) }))
          .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
  );

export const NetworkProfileProvider = () =>
  Provider.succeed(
    NetworkProfile,
    networkProvider<NetworkProfile>()({
      label: "network profile",
      nameAttr: "networkProfileName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkProfile({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkProfileName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkProfilesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkProfileName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkProfile({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkProfileName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateNetworkProfileTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkProfileName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListNetworkProfileAll({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          containerNetworkInterfaceConfigurations: news.containerNetworkInterfaceConfigurations.map(
            (configuration) => ({
              name: configuration.name,
              properties: {
                ipConfigurations: configuration.ipConfigurations.map((ip) => ({
                  name: ip.name,
                  properties: { subnet: { id: ip.subnetId } },
                })),
              },
            }),
          ),
        },
      }),
      drifted: (observed, _body, news) =>
        projectConfigurations(
          (observed.properties?.containerNetworkInterfaceConfigurations ?? []).map((c) => ({
            name: c.name,
            ipConfigurations: (c.properties?.ipConfigurations ?? []).map((ip) => ({
              name: ip.name,
              subnetId: ip.properties?.subnet?.id,
            })),
          })),
        ) !== projectConfigurations(news.containerNetworkInterfaceConfigurations),
      toAttrs: (path, observed) => ({
        networkProfileName: path.name,
        networkProfileId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        containerNetworkInterfaceIds: idsOf(observed.properties?.containerNetworkInterfaces),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.Subnet", "Azure.Network.VirtualNetwork"],
    }),
  );
