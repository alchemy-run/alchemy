import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import { perimeterTags } from "./networkSecurityPerimeterShared.ts";

export interface NetworkSecurityPerimeterProfileProps {
  /** Resource group of the perimeter. Changing it replaces the perimeter profile. */
  resourceGroup: string;
  /** Name of the parent network security perimeter. Changing it replaces the perimeter profile. */
  networkSecurityPerimeter: string;
  /**
   * Name of the perimeter profile. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the perimeter profile.
   */
  name?: string;
}

export interface NetworkSecurityPerimeterProfile extends Resource<
  "Azure.Network.NetworkSecurityPerimeterProfile",
  NetworkSecurityPerimeterProfileProps,
  {
    /** Name of the perimeter profile. */
    profileName: string;
    /** ARM resource ID of the perimeter profile. */
    profileId: string;
    /** Name of the parent network security perimeter. */
    networkSecurityPerimeter: string;
    /** Resource group of the perimeter. */
    resourceGroup: string;
    /** Version of the profile's access rules. */
    accessRulesVersion: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A profile of an Azure network security perimeter — a named set of
 * {@link NetworkSecurityPerimeterAccessRule}s that associated resources
 * use. It carries no tags: ownership follows the perimeter.
 *
 * @see https://learn.microsoft.com/azure/private-link/network-security-perimeter-concepts
 *
 * ### Creating a Profile
 * **Example:** Default profile
 * ```typescript
 * const profile = yield* Azure.Network.NetworkSecurityPerimeterProfile("default", {
 *   resourceGroup: group.resourceGroupName,
 *   networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
 * });
 * ```
 *
 * @resource
 */
export const NetworkSecurityPerimeterProfile =
  Resource<NetworkSecurityPerimeterProfile>(
    "Azure.Network.NetworkSecurityPerimeterProfile",
  );

export const NetworkSecurityPerimeterProfileProvider = () =>
  Provider.succeed(
    NetworkSecurityPerimeterProfile,
    networkProvider<NetworkSecurityPerimeterProfile>()({
      label: "perimeter profile",
      nameAttr: "profileName",
      parents: ["networkSecurityPerimeter"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkSecurityPerimeterProfile({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkSecurityPerimeterName: path.networkSecurityPerimeter!,
            profileName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkSecurityPerimeterProfilesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.networkSecurityPerimeter!,
          profileName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkSecurityPerimeterProfile({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.networkSecurityPerimeter!,
          profileName: path.name,
        }),
      ownerTags: perimeterTags,
      body: () => ({ properties: {} }),
      drifted: () => false,
      toAttrs: (path, observed) => ({
        profileName: path.name,
        profileId: observed.id ?? "",
        networkSecurityPerimeter: path.networkSecurityPerimeter!,
        resourceGroup: path.resourceGroup,
        accessRulesVersion: observed.properties?.accessRulesVersion,
      }),
      dependsOn: ["Azure.Network.NetworkSecurityPerimeter"],
    }),
  );
