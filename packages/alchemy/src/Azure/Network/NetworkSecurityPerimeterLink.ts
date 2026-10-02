import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameId, sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";
import { perimeterTags } from "./networkSecurityPerimeterShared.ts";

export interface NetworkSecurityPerimeterLinkProps {
  /** Resource group of the perimeter. Changing it replaces the perimeter link. */
  resourceGroup: string;
  /** Name of the parent network security perimeter. Changing it replaces the perimeter link. */
  networkSecurityPerimeter: string;
  /**
   * Name of the perimeter link. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the perimeter link.
   */
  name?: string;
  /**
   * ARM ID of the remote perimeter. The link is auto-approved when the
   * caller has access to it. Changing it replaces the link.
   */
  remotePerimeterId: string;
  /** Local inbound profile names (`["*"]` for all). @default ["*"] */
  localInboundProfiles?: string[];
  /** Remote inbound profile names (`["*"]` for all). @default ["*"] */
  remoteInboundProfiles?: string[];
  /**
   * Description. Azure replaces it with the approval message (e.g.
   * `Auto Approved.`) once the link is approved.
   */
  description?: string;
}

export interface NetworkSecurityPerimeterLink extends Resource<
  "Azure.Network.NetworkSecurityPerimeterLink",
  NetworkSecurityPerimeterLinkProps,
  {
    /** Name of the perimeter link. */
    linkName: string;
    /** ARM resource ID of the perimeter link. */
    linkId: string;
    /** Name of the parent network security perimeter. */
    networkSecurityPerimeter: string;
    /** Resource group of the perimeter. */
    resourceGroup: string;
    /** ARM ID of the remote perimeter. */
    remotePerimeterId: string | undefined;
    /** Link status (`Approved`, `Pending`, ...). */
    status: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A link between two Azure network security perimeters — lets the
 * linked perimeters' profiles accept each other's traffic. Linking a
 * perimeter you can access is auto-approved (a matching link reference is
 * created on the remote side). It carries no tags: ownership follows the
 * perimeter.
 *
 * @see https://learn.microsoft.com/azure/private-link/network-security-perimeter-concepts
 *
 * ### Linking Perimeters
 * **Example:** Link to another perimeter
 * ```typescript
 * yield* Azure.Network.NetworkSecurityPerimeterLink("to-shared", {
 *   resourceGroup: group.resourceGroupName,
 *   networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
 *   remotePerimeterId: shared.networkSecurityPerimeterId,
 * });
 * ```
 *
 * @resource
 */
export const NetworkSecurityPerimeterLink =
  Resource<NetworkSecurityPerimeterLink>(
    "Azure.Network.NetworkSecurityPerimeterLink",
  );

export const NetworkSecurityPerimeterLinkProvider = () =>
  Provider.succeed(
    NetworkSecurityPerimeterLink,
    networkProvider<NetworkSecurityPerimeterLink>()({
      label: "perimeter link",
      nameAttr: "linkName",
      parents: ["networkSecurityPerimeter"],
      tracked: false,
      immutable: (news, output) =>
        !sameId(news.remotePerimeterId, output.remotePerimeterId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetNetworkSecurityPerimeterLink({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            networkSecurityPerimeterName: path.networkSecurityPerimeter!,
            linkName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.NetworkSecurityPerimeterLinksCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.networkSecurityPerimeter!,
          linkName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteNetworkSecurityPerimeterLink({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          networkSecurityPerimeterName: path.networkSecurityPerimeter!,
          linkName: path.name,
        }),
      ownerTags: perimeterTags,
      body: (news) => ({
        properties: {
          autoApprovedRemotePerimeterResourceId: news.remotePerimeterId,
          localInboundProfiles: news.localInboundProfiles ?? ["*"],
          remoteInboundProfiles: news.remoteInboundProfiles ?? ["*"],
          description: news.description,
        },
      }),
      drifted: (observed, _body, news) =>
        !sameSet(
          observed.properties?.localInboundProfiles,
          news.localInboundProfiles ?? ["*"],
        ) ||
        !sameSet(
          observed.properties?.remoteInboundProfiles,
          news.remoteInboundProfiles ?? ["*"],
        ),
      toAttrs: (path, observed) => ({
        linkName: path.name,
        linkId: observed.id ?? "",
        networkSecurityPerimeter: path.networkSecurityPerimeter!,
        resourceGroup: path.resourceGroup,
        remotePerimeterId:
          observed.properties?.autoApprovedRemotePerimeterResourceId,
        status: observed.properties?.status,
      }),
      dependsOn: ["Azure.Network.NetworkSecurityPerimeter"],
    }),
  );
