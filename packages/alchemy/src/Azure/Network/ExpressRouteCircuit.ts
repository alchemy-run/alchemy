import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { lower } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface ExpressRouteCircuitProps {
  /** Resource group of the circuit. Changing it replaces the circuit. */
  resourceGroup: string;
  /**
   * Name of the circuit: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the circuit.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the circuit.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * SKU tier. `Standard` can be upgraded to `Premium` in place.
   * @default "Standard"
   */
  tier?: "Standard" | "Premium" | "Basic" | "Local";
  /**
   * Billing family. `MeteredData` can be changed to `UnlimitedData` in
   * place (not back).
   * @default "MeteredData"
   */
  family?: "MeteredData" | "UnlimitedData";
  /**
   * Connectivity provider, e.g. `"Equinix"`. Changing it replaces the
   * circuit.
   */
  serviceProviderName: string;
  /**
   * Peering location of the provider, e.g. `"Silicon Valley"`. Changing it
   * replaces the circuit.
   */
  peeringLocation: string;
  /**
   * Bandwidth in Mbps (e.g. `50`, `100`, `1000`). Can be increased in place
   * once the provider has provisioned the circuit.
   */
  bandwidthInMbps: number;
  /**
   * Allow classic (ASM) virtual networks to use the circuit.
   * @default false
   */
  allowClassicOperations?: boolean;
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ExpressRouteCircuit extends Resource<
  "Azure.Network.ExpressRouteCircuit",
  ExpressRouteCircuitProps,
  {
    /** Name of the circuit. */
    circuitName: string;
    /** ARM resource ID of the circuit. */
    circuitId: string;
    /** Resource group of the circuit. */
    resourceGroup: string;
    /** Location of the circuit. */
    location: string;
    /** SKU tier. */
    tier: string | undefined;
    /** Billing family. */
    family: string | undefined;
    /** Connectivity provider. */
    serviceProviderName: string | undefined;
    /** Peering location. */
    peeringLocation: string | undefined;
    /** Bandwidth in Mbps. */
    bandwidthInMbps: number | undefined;
    /**
     * Service key to hand to the connectivity provider so it can
     * provision the circuit.
     */
    serviceKey: string | undefined;
    /**
     * Provider-side state: `NotProvisioned`, `Provisioning`,
     * `Provisioned`, or `Deprovisioning`.
     */
    serviceProviderProvisioningState: string | undefined;
    /** IDs of the circuit's authorizations. */
    authorizationIds: string[];
    /** IDs of the circuit's peerings. */
    peeringIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure ExpressRoute circuit — a private, dedicated connection to Azure
 * through a connectivity provider. Azure issues a `serviceKey` you hand to
 * the provider; peerings and connections can only be configured once the
 * provider has provisioned the circuit. Circuits bill from creation (a
 * 50 Mbps metered Standard circuit is ≈ $55/month).
 *
 * Changing the provider, peering location, or location replaces the
 * circuit; tier (`Standard` → `Premium`), family (`MeteredData` →
 * `UnlimitedData`), bandwidth increases, and tags update in place.
 *
 * @see https://learn.microsoft.com/azure/expressroute/expressroute-introduction
 *
 * ### Creating a Circuit
 * **Example:** 50 Mbps metered circuit through Equinix
 * ```typescript
 * const circuit = yield* Azure.Network.ExpressRouteCircuit("onprem", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceProviderName: "Equinix",
 *   peeringLocation: "Silicon Valley",
 *   bandwidthInMbps: 50,
 * });
 * // Give circuit.serviceKey to the provider.
 * ```
 *
 * **Example:** Premium unlimited circuit
 * ```typescript
 * const circuit = yield* Azure.Network.ExpressRouteCircuit("global", {
 *   resourceGroup: group.resourceGroupName,
 *   tier: "Premium",
 *   family: "UnlimitedData",
 *   serviceProviderName: "Equinix",
 *   peeringLocation: "Washington DC",
 *   bandwidthInMbps: 1000,
 * });
 * ```
 *
 * @resource
 */
export const ExpressRouteCircuit = Resource<ExpressRouteCircuit>(
  "Azure.Network.ExpressRouteCircuit",
);

export const ExpressRouteCircuitProvider = () =>
  Provider.succeed(
    ExpressRouteCircuit,
    networkProvider<ExpressRouteCircuit>()({
      label: "ExpressRoute circuit",
      nameAttr: "circuitName",
      tracked: true,
      // Circuit creation stays `Updating` for 5-15 minutes.
      slow: true,
      immutable: (news, output) =>
        lower(news.serviceProviderName) !== lower(output.serviceProviderName) ||
        lower(news.peeringLocation) !== lower(output.peeringLocation),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetExpressRouteCircuit({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            circuitName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ExpressRouteCircuitsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          circuitName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteExpressRouteCircuit({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          circuitName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateExpressRouteCircuitTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          circuitName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListExpressRouteCircuitAll({ subscriptionId }),
      body: (news, { location, tags, observed }) => {
        const tier = news.tier ?? "Standard";
        const family = news.family ?? "MeteredData";
        return {
          location,
          tags,
          sku: { name: `${tier}_${family}`, tier, family },
          properties: {
            allowClassicOperations: news.allowClassicOperations ?? false,
            serviceProviderProperties: {
              serviceProviderName: news.serviceProviderName,
              peeringLocation: news.peeringLocation,
              bandwidthInMbps: news.bandwidthInMbps,
            },
            // The circuit PUT replaces its child collections: re-send the
            // observed authorizations and peerings so they survive.
            authorizations: observed?.properties?.authorizations?.map(
              (a): network.ExpressRouteCircuitAuthorizationInput => ({
                id: a.id,
                name: a.name,
              }),
            ),
            peerings: observed?.properties?.peerings?.map(
              (p): network.ExpressRouteCircuitPeeringInput => ({
                id: p.id,
                name: p.name,
                properties:
                  p.properties as unknown as network.ExpressRouteCircuitPeeringPropertiesFormatInput,
              }),
            ),
          },
        };
      },
      drifted: (observed, body) =>
        lower(observed.sku?.tier) !== lower(body.sku.tier) ||
        lower(observed.sku?.family) !== lower(body.sku.family) ||
        (observed.properties?.allowClassicOperations ?? false) !==
          body.properties.allowClassicOperations ||
        observed.properties?.serviceProviderProperties?.bandwidthInMbps !==
          body.properties.serviceProviderProperties.bandwidthInMbps,
      toAttrs: (path, observed) => ({
        circuitName: path.name,
        circuitId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        tier: observed.sku?.tier,
        family: observed.sku?.family,
        serviceProviderName:
          observed.properties?.serviceProviderProperties?.serviceProviderName,
        peeringLocation:
          observed.properties?.serviceProviderProperties?.peeringLocation,
        bandwidthInMbps:
          observed.properties?.serviceProviderProperties?.bandwidthInMbps,
        serviceKey: observed.properties?.serviceKey,
        serviceProviderProvisioningState:
          observed.properties?.serviceProviderProvisioningState,
        authorizationIds: idsOf(observed.properties?.authorizations),
        peeringIds: idsOf(observed.properties?.peerings),
        tags: userTags(observed.tags),
      }),
    }),
  );
