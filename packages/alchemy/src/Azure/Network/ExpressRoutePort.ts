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
import { idsOf, networkProvider } from "./generic.ts";

export interface ExpressRoutePortProps {
  /** Resource group of the port. Changing it replaces the port. */
  resourceGroup: string;
  /**
   * Name of the port: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the port.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the port.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ExpressRoute Direct peering location, e.g. `"Equinix-Ashburn-DC2"`
   * (see `ListExpressRoutePortsLocations`). Changing it replaces the port.
   */
  peeringLocation: string;
  /**
   * Bandwidth of each physical port in Gbps (`10` or `100`). Changing it
   * replaces the port.
   */
  bandwidthInGbps: number;
  /**
   * Encapsulation on the physical ports. Changing it replaces the port.
   * @default "Dot1Q"
   */
  encapsulation?: "Dot1Q" | "QinQ";
  /**
   * Billing type. `MeteredData` can be changed to `UnlimitedData`.
   * @default "MeteredData"
   */
  billingType?: "MeteredData" | "UnlimitedData";
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

export interface ExpressRoutePort extends Resource<
  "Azure.Network.ExpressRoutePort",
  ExpressRoutePortProps,
  {
    /** Name of the port. */
    expressRoutePortName: string;
    /** ARM resource ID of the port. */
    expressRoutePortId: string;
    /** Resource group of the port. */
    resourceGroup: string;
    /** Location of the port. */
    location: string;
    /** Peering location. */
    peeringLocation: string | undefined;
    /** Bandwidth of each physical port in Gbps. */
    bandwidthInGbps: number | undefined;
    /** Aggregate bandwidth of the circuits provisioned on the port. */
    provisionedBandwidthInGbps: number | undefined;
    /** Encapsulation. */
    encapsulation: string | undefined;
    /** Billing type. */
    billingType: string | undefined;
    /** Names of the physical links. */
    linkNames: string[];
    /** IDs of the circuits provisioned on the port. */
    circuitIds: string[];
    /** User-assigned identity IDs. */
    userAssignedIdentityIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure ExpressRoute Direct port pair — dedicated 10/100 Gbps physical
 * ports at a Microsoft peering location, on which you create
 * ExpressRoute circuits yourself. Ports bill from creation (≈ $5,000+/month
 * for a 10 Gbps pair) and require a Letter of Authorization to be
 * cross-connected; subscriptions must be enabled for ExpressRoute Direct.
 *
 * @see https://learn.microsoft.com/azure/expressroute/expressroute-erdirect-about
 *
 * ### Ordering Ports
 * **Example:** 10 Gbps port pair
 * ```typescript
 * const port = yield* Azure.Network.ExpressRoutePort("direct", {
 *   resourceGroup: group.resourceGroupName,
 *   peeringLocation: "Equinix-Ashburn-DC2",
 *   bandwidthInGbps: 10,
 *   encapsulation: "Dot1Q",
 * });
 * ```
 *
 * **Example:** Disable one link for maintenance
 * ```typescript
 * const port = yield* Azure.Network.ExpressRoutePort("direct", {
 *   resourceGroup: group.resourceGroupName,
 *   peeringLocation: "Equinix-Ashburn-DC2",
 *   bandwidthInGbps: 10,
 *   links: [{ name: "link2", adminState: "Disabled" }],
 * });
 * ```
 *
 * @resource
 */
export const ExpressRoutePort = Resource<ExpressRoutePort>(
  "Azure.Network.ExpressRoutePort",
);

export const ExpressRoutePortProvider = () =>
  Provider.succeed(
    ExpressRoutePort,
    networkProvider<ExpressRoutePort>()({
      label: "ExpressRoute port",
      nameAttr: "expressRoutePortName",
      tracked: true,
      slow: true,
      immutable: (news, output) =>
        lower(news.peeringLocation) !== lower(output.peeringLocation) ||
        news.bandwidthInGbps !== output.bandwidthInGbps ||
        lower(news.encapsulation ?? "Dot1Q") !==
          lower(output.encapsulation ?? "Dot1Q"),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRoutePort({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            expressRoutePortName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ExpressRoutePortsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRoutePortName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteExpressRoutePort({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRoutePortName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateExpressRoutePortTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          expressRoutePortName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListExpressRoutePorts({ subscriptionId }),
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
        },
      }),
      drifted: (observed, _body, news) =>
        lower(observed.properties?.billingType ?? "MeteredData") !==
          lower(news.billingType ?? "MeteredData") ||
        linksDrifted(observed.properties?.links, news.links) ||
        (news.userAssignedIdentityIds !== undefined &&
          !sameSet(
            identityIds(observed.identity),
            news.userAssignedIdentityIds,
          )),
      toAttrs: (path, observed) => ({
        expressRoutePortName: path.name,
        expressRoutePortId: observed.id ?? "",
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
        circuitIds: idsOf(observed.properties?.circuits),
        userAssignedIdentityIds: identityIds(observed.identity),
        tags: userTags(observed.tags),
      }),
    }),
  );
