import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { lower, sameSet } from "./common.ts";
import {
  type ExpressRouteLinkConfig,
  identityIds,
  identityInput,
  linksDrifted,
  linksInput,
} from "./expressRouteDirectShared.ts";
import { networkProvider } from "./generic.ts";

export interface ExpressRouteLagProps {
  /** Resource group of the LAG. Changing it replaces the LAG. */
  resourceGroup: string;
  /**
   * Name of the LAG: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the LAG.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the LAG.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ExpressRoute Direct peering location, e.g. `"Equinix-Ashburn-DC2"`
   * (see `ListExpressRouteLagsLocations`). Changing it replaces the LAG.
   */
  peeringLocation: string;
  /**
   * Bandwidth of each physical port in Gbps (`10` or `100`). Changing it
   * replaces the LAG.
   */
  bandwidthInGbps: number;
  /**
   * Encapsulation on the physical ports. Changing it replaces the LAG.
   * @default "Dot1Q"
   */
  encapsulation?: "Dot1Q" | "QinQ";
  /**
   * Billing type. `MeteredData` can be changed to `UnlimitedData`.
   * @default "MeteredData"
   */
  billingType?: "MeteredData" | "UnlimitedData";
  /**
   * Number of physical ports in the LAG. Changing it replaces the LAG.
   */
  numberOfPorts?: number;
  /**
   * Minimum number of active ports for the LAG to stay up.
   */
  minimumActivePortsRequired?: number;
  /**
   * LACP timer.
   * @default "Slow"
   */
  lacpTimer?: "Fast" | "Slow";
  /** Admin state / MACsec settings of the physical links. */
  links?: ExpressRouteLinkConfig[];
  /**
   * User-assigned identities allowed to read MACsec secrets from Key
   * Vault.
   */
  userAssignedIdentityIds?: string[];
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ExpressRouteLag extends Resource<
  "Azure.Network.ExpressRouteLag",
  ExpressRouteLagProps,
  {
    /** Name of the LAG. */
    expressRouteLagName: string;
    /** ARM resource ID of the LAG. */
    expressRouteLagId: string;
    /** Resource group of the LAG. */
    resourceGroup: string;
    /** Location of the LAG. */
    location: string;
    /** Peering location. */
    peeringLocation: string | undefined;
    /** Bandwidth of each physical port in Gbps. */
    bandwidthInGbps: number | undefined;
    /** Aggregate bandwidth of the circuits provisioned on the LAG. */
    provisionedBandwidthInGbps: number | undefined;
    /** Encapsulation. */
    encapsulation: string | undefined;
    /** Billing type. */
    billingType: string | undefined;
    /** Number of physical ports. */
    numberOfPorts: number | undefined;
    /** Minimum number of active ports. */
    minimumActivePortsRequired: number | undefined;
    /** LACP timer. */
    lacpTimer: string | undefined;
    /** Names of the physical links. */
    linkNames: string[];
    /** User-assigned identity IDs. */
    userAssignedIdentityIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure ExpressRoute Direct link aggregation group (LAG) — several
 * dedicated physical ports at a Microsoft peering location bundled with
 * LACP into one logical ExpressRoute Direct resource. LAGs bill from
 * creation and require a Letter of Authorization to be cross-connected;
 * subscriptions must be enabled for ExpressRoute Direct.
 *
 * @see https://learn.microsoft.com/azure/expressroute/expressroute-erdirect-about
 *
 * ### Ordering a LAG
 * **Example:** Four 10 Gbps ports
 * ```typescript
 * const lag = yield* Azure.Network.ExpressRouteLag("direct", {
 *   resourceGroup: group.resourceGroupName,
 *   peeringLocation: "Equinix-Ashburn-DC2",
 *   bandwidthInGbps: 10,
 *   numberOfPorts: 4,
 *   minimumActivePortsRequired: 2,
 *   lacpTimer: "Fast",
 * });
 * ```
 *
 * @resource
 */
export const ExpressRouteLag = Resource<ExpressRouteLag>(
  "Azure.Network.ExpressRouteLag",
);

export const ExpressRouteLagProvider = () =>
  Provider.succeed(
    ExpressRouteLag,
    networkProvider<ExpressRouteLag>()({
      label: "ExpressRoute LAG",
      nameAttr: "expressRouteLagName",
      tracked: true,
      slow: true,
      immutable: (news, output) =>
        lower(news.peeringLocation) !== lower(output.peeringLocation) ||
        news.bandwidthInGbps !== output.bandwidthInGbps ||
        lower(news.encapsulation ?? "Dot1Q") !==
          lower(output.encapsulation ?? "Dot1Q") ||
        (news.numberOfPorts !== undefined &&
          output.numberOfPorts !== undefined &&
          news.numberOfPorts !== output.numberOfPorts),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRouteLag({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            expressRouteLagName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ExpressRouteLagsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRouteLagName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteExpressRouteLag({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRouteLagName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateExpressRouteLag({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRouteLagName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListExpressRouteLags({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        identity: identityInput(news.userAssignedIdentityIds),
        properties: {
          peeringLocation: news.peeringLocation,
          bandwidthInGbps: news.bandwidthInGbps,
          encapsulation: news.encapsulation ?? "Dot1Q",
          billingType: news.billingType ?? "MeteredData",
          links: linksInput(news.links),
          numberOfPorts: news.numberOfPorts,
          minimumActivePortsRequired: news.minimumActivePortsRequired,
          lacpTimer: news.lacpTimer,
        },
      }),
      drifted: (observed, _body, news) =>
        lower(observed.properties?.billingType ?? "MeteredData") !==
          lower(news.billingType ?? "MeteredData") ||
        linksDrifted(observed.properties?.links, news.links) ||
        (news.minimumActivePortsRequired !== undefined &&
          observed.properties?.minimumActivePortsRequired !==
            news.minimumActivePortsRequired) ||
        (news.lacpTimer !== undefined &&
          lower(observed.properties?.lacpTimer) !== lower(news.lacpTimer)) ||
        (news.userAssignedIdentityIds !== undefined &&
          !sameSet(
            identityIds(observed.identity),
            news.userAssignedIdentityIds,
          )),
      toAttrs: (path, observed) => ({
        expressRouteLagName: path.name,
        expressRouteLagId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        peeringLocation: observed.properties?.peeringLocation,
        bandwidthInGbps: observed.properties?.bandwidthInGbps,
        provisionedBandwidthInGbps:
          observed.properties?.provisionedBandwidthInGbps,
        encapsulation: observed.properties?.encapsulation,
        billingType: observed.properties?.billingType,
        linkNames: (observed.properties?.links ?? []).flatMap((link) =>
          link.name === undefined ? [] : [link.name],
        ),
        numberOfPorts: observed.properties?.numberOfPorts,
        minimumActivePortsRequired:
          observed.properties?.minimumActivePortsRequired,
        lacpTimer: observed.properties?.lacpTimer,
        userAssignedIdentityIds: identityIds(observed.identity),
        tags: userTags(observed.tags),
      }),
    }),
  );
