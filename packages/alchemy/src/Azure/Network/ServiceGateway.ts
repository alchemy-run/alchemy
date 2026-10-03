import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { lower, ref, sameId, sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";

/** A route target address of a service gateway. */
export interface ServiceGatewayRouteTarget {
  /** ARM ID of the subnet holding the route target address. */
  subnetId: string;
  /** Static private IP address (omit for dynamic allocation). */
  privateIpAddress?: string;
  /**
   * Allocation method of the private IP address.
   * @default "Dynamic" (or "Static" when `privateIpAddress` is set)
   */
  privateIpAllocationMethod?: "Static" | "Dynamic";
}

export interface ServiceGatewayProps {
  /** Resource group of the service gateway. Changing it replaces the gateway. */
  resourceGroup: string;
  /**
   * Name of the service gateway: 1-80 letters, digits, `_`, `.`, and `-`.
   * If omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the gateway.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the gateway.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zones. Changing them replaces the gateway.
   */
  zones?: string[];
  /** ARM ID of the virtual network the gateway serves. Changing it replaces the gateway. */
  virtualNetworkId: string;
  /** IPv4 route target address. */
  routeTarget?: ServiceGatewayRouteTarget;
  /** IPv6 route target address. */
  routeTargetV6?: ServiceGatewayRouteTarget;
  /**
   * User tags. Alchemy ownership tags are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ServiceGateway extends Resource<
  "Azure.Network.ServiceGateway",
  ServiceGatewayProps,
  {
    /** Name of the service gateway. */
    serviceGatewayName: string;
    /** ARM resource ID of the service gateway. */
    serviceGatewayId: string;
    /** Resource group of the service gateway. */
    resourceGroup: string;
    /** Location of the service gateway. */
    location: string;
    /** Availability zones. */
    zones: string[];
    /** ARM ID of the virtual network. */
    virtualNetworkId: string | undefined;
    /** IPv4 route target private IP address. */
    routeTargetIpAddress: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure service gateway (preview) — a regional, VNet-scoped gateway
 * (`Standard` SKU) that routes subnet traffic to Azure services through a
 * route target address in the virtual network. Subnets and NAT gateways
 * reference it by ID.
 *
 * @see https://learn.microsoft.com/rest/api/virtualnetwork/service-gateways
 *
 * ### Creating a Service Gateway
 * **Example:** Service gateway for a virtual network
 * ```typescript
 * const gateway = yield* Azure.Network.ServiceGateway("svc", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetworkId: vnet.virtualNetworkId,
 *   routeTarget: { subnetId: subnet.subnetId },
 * });
 * ```
 *
 * @resource
 */
export const ServiceGateway = Resource<ServiceGateway>(
  "Azure.Network.ServiceGateway",
);

const routeTargetInput = (target: ServiceGatewayRouteTarget | undefined) =>
  target === undefined
    ? undefined
    : {
        subnet: { id: target.subnetId },
        privateIPAddress: target.privateIpAddress,
        privateIPAllocationMethod:
          target.privateIpAllocationMethod ??
          (target.privateIpAddress !== undefined ? "Static" : "Dynamic"),
      };

const routeTargetDrifted = (
  observed: network.RouteTargetAddressPropertiesFormat | undefined,
  desired: ServiceGatewayRouteTarget | undefined,
) =>
  desired !== undefined &&
  (!sameId(observed?.subnet?.id, desired.subnetId) ||
    (desired.privateIpAddress !== undefined &&
      observed?.privateIPAddress !== desired.privateIpAddress));

export const ServiceGatewayProvider = () =>
  Provider.succeed(
    ServiceGateway,
    networkProvider<ServiceGateway>()({
      label: "service gateway",
      nameAttr: "serviceGatewayName",
      tracked: true,
      immutable: (news, output) =>
        !sameId(news.virtualNetworkId, output.virtualNetworkId) ||
        !sameSet(news.zones, output.zones),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetServiceGateway({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            serviceGatewayName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ServiceGatewaysCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceGatewayName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteServiceGateway({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceGatewayName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateServiceGatewayTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceGatewayName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListServiceGatewayAll({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        sku: { name: "Standard", tier: "Regional" },
        zones: news.zones,
        properties: {
          virtualNetwork: ref(news.virtualNetworkId),
          routeTargetAddress: routeTargetInput(news.routeTarget),
          routeTargetAddressV6: routeTargetInput(news.routeTargetV6),
        },
      }),
      drifted: (observed, _body, news) =>
        routeTargetDrifted(
          observed.properties?.routeTargetAddress,
          news.routeTarget,
        ) ||
        routeTargetDrifted(
          observed.properties?.routeTargetAddressV6,
          news.routeTargetV6,
        ) ||
        lower(observed.sku?.name) !== "standard",
      toAttrs: (path, observed) => ({
        serviceGatewayName: path.name,
        serviceGatewayId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        zones: [...(observed.zones ?? [])],
        virtualNetworkId: observed.properties?.virtualNetwork?.id,
        routeTargetIpAddress:
          observed.properties?.routeTargetAddress?.privateIPAddress,
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.Subnet", "Azure.Network.VirtualNetwork"],
    }),
  );
