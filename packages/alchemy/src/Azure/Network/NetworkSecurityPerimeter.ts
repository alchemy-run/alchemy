import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";

export interface NetworkSecurityPerimeterProps {
  /** Resource group of the perimeter. Changing it replaces the perimeter. */
  resourceGroup: string;
  /**
   * Name of the perimeter: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the perimeter.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the perimeter.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface NetworkSecurityPerimeter extends Resource<
  "Azure.Network.NetworkSecurityPerimeter",
  NetworkSecurityPerimeterProps,
  {
    /** Name of the perimeter. */
    networkSecurityPerimeterName: string;
    /** ARM resource ID of the perimeter. */
    networkSecurityPerimeterId: string;
    /** Resource group of the perimeter. */
    resourceGroup: string;
    /** Location of the perimeter. */
    location: string;
    /** Immutable perimeter GUID. */
    perimeterGuid: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure network security perimeter — a logical boundary around PaaS
 * resources (Storage, Key Vault, SQL, Event Hubs, ...) that blocks public
 * access except what its profiles' access rules allow. Add
 * {@link NetworkSecurityPerimeterProfile}s, then associate resources with
 * {@link NetworkSecurityPerimeterAssociation}. Perimeters are free.
 *
 * @see https://learn.microsoft.com/azure/private-link/network-security-perimeter-concepts
 *
 * ### Creating a Perimeter
 * **Example:** Perimeter with a profile
 * ```typescript
 * const perimeter = yield* Azure.Network.NetworkSecurityPerimeter("data", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const profile = yield* Azure.Network.NetworkSecurityPerimeterProfile("default", {
 *   resourceGroup: group.resourceGroupName,
 *   networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
 * });
 * ```
 *
 * @resource
 */
export const NetworkSecurityPerimeter = Resource<NetworkSecurityPerimeter>(
  "Azure.Network.NetworkSecurityPerimeter",
);

export const NetworkSecurityPerimeterProvider = () =>
  Provider.succeed(
    NetworkSecurityPerimeter,
    networkProvider<NetworkSecurityPerimeter>()({
      label: "network security perimeter",
      nameAttr: "networkSecurityPerimeterName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkSecurityPerimeter({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkSecurityPerimeterName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkSecurityPerimetersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkSecurityPerimeter({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.name,
          forceDeletion: true,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.PatchNetworkSecurityPerimeter({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListNetworkSecurityPerimeterBySubscription({ subscriptionId }),
      body: (_news, { location, tags }) => ({ location, tags, properties: {} }),
      drifted: () => false,
      toAttrs: (path, observed) => ({
        networkSecurityPerimeterName: path.name,
        networkSecurityPerimeterId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        perimeterGuid: observed.properties?.perimeterGuid,
        tags: userTags(observed.tags),
      }),
    }),
  );
