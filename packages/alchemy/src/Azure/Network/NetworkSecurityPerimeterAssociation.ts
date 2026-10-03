import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId } from "./common.ts";
import { networkProvider } from "./generic.ts";
import { perimeterTags } from "./networkSecurityPerimeterShared.ts";

export interface NetworkSecurityPerimeterAssociationProps {
  /** Resource group of the perimeter. Changing it replaces the perimeter association. */
  resourceGroup: string;
  /** Name of the parent network security perimeter. Changing it replaces the perimeter association. */
  networkSecurityPerimeter: string;
  /**
   * Name of the perimeter association. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the perimeter association.
   */
  name?: string;
  /**
   * ARM ID of the PaaS resource (storage account, key vault, ...) placed in
   * the perimeter. Changing it replaces the association.
   */
  privateLinkResourceId: string;
  /** ARM ID of the perimeter profile whose access rules apply. */
  profileId: string;
  /**
   * `Learning` (log only, keep public access) or `Enforced` (block what
   * the profile does not allow). `Audit` is not supported for most
   * resource types.
   * @default "Learning"
   */
  accessMode?: "Learning" | "Enforced" | "Audit";
}

export interface NetworkSecurityPerimeterAssociation extends Resource<
  "Azure.Network.NetworkSecurityPerimeterAssociation",
  NetworkSecurityPerimeterAssociationProps,
  {
    /** Name of the perimeter association. */
    associationName: string;
    /** ARM resource ID of the perimeter association. */
    associationId: string;
    /** Name of the parent network security perimeter. */
    networkSecurityPerimeter: string;
    /** Resource group of the perimeter. */
    resourceGroup: string;
    /** ARM ID of the associated resource. */
    privateLinkResourceId: string | undefined;
    /** ARM ID of the applied profile. */
    profileId: string | undefined;
    /** Access mode. */
    accessMode: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An association of a PaaS resource with an Azure network security
 * perimeter profile. In `Enforced` mode, public traffic the profile does
 * not allow is blocked. It carries no tags: ownership follows the
 * perimeter.
 *
 * @see https://learn.microsoft.com/azure/private-link/network-security-perimeter-concepts
 *
 * ### Associating a Resource
 * **Example:** Put a storage account in the perimeter (learning mode)
 * ```typescript
 * yield* Azure.Network.NetworkSecurityPerimeterAssociation("storage", {
 *   resourceGroup: group.resourceGroupName,
 *   networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
 *   privateLinkResourceId: account.storageAccountId,
 *   profileId: profile.profileId,
 * });
 * ```
 *
 * @resource
 */
export const NetworkSecurityPerimeterAssociation =
  Resource<NetworkSecurityPerimeterAssociation>(
    "Azure.Network.NetworkSecurityPerimeterAssociation",
  );

export const NetworkSecurityPerimeterAssociationProvider = () =>
  Provider.succeed(
    NetworkSecurityPerimeterAssociation,
    networkProvider<NetworkSecurityPerimeterAssociation>()({
      label: "perimeter association",
      nameAttr: "associationName",
      parents: ["networkSecurityPerimeter"],
      tracked: false,
      slow: true,
      immutable: (news, output) =>
        !sameId(news.privateLinkResourceId, output.privateLinkResourceId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkSecurityPerimeterAssociation({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkSecurityPerimeterName: path.networkSecurityPerimeter!,
            associationName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkSecurityPerimeterAssociationsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.networkSecurityPerimeter!,
          associationName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkSecurityPerimeterAssociation({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.networkSecurityPerimeter!,
          associationName: path.name,
        }),
      ownerTags: perimeterTags,
      body: (news) => ({
        properties: {
          privateLinkResource: { id: news.privateLinkResourceId },
          profile: { id: news.profileId },
          accessMode: news.accessMode ?? "Learning",
        },
      }),
      toAttrs: (path, observed) => ({
        associationName: path.name,
        associationId: observed.id ?? "",
        networkSecurityPerimeter: path.networkSecurityPerimeter!,
        resourceGroup: path.resourceGroup,
        privateLinkResourceId: observed.properties?.privateLinkResource?.id,
        profileId: observed.properties?.profile?.id,
        accessMode: observed.properties?.accessMode,
      }),
      dependsOn: ["Azure.Network.NetworkSecurityPerimeter"],
    }),
  );
