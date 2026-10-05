import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { ref, sameId } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface VirtualRouterProps {
  /** Resource group of the router. Changing it replaces the router. */
  resourceGroup: string;
  /**
   * Name of the router: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the router.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the router.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the subnet hosting the router. Changing it replaces the
   * router.
   */
  hostedSubnetId?: string;
  /**
   * ARM ID of the virtual network gateway hosting the router (legacy).
   * Changing it replaces the router.
   */
  hostedGatewayId?: string;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface VirtualRouter extends Resource<
  "Azure.Network.VirtualRouter",
  VirtualRouterProps,
  {
    /** Name of the router. */
    virtualRouterName: string;
    /** ARM resource ID of the router. */
    virtualRouterId: string;
    /** Resource group of the router. */
    resourceGroup: string;
    /** Location of the router. */
    location: string;
    /** BGP ASN of the router (65515). */
    virtualRouterAsn: number | undefined;
    /** IP addresses of the router instances. */
    virtualRouterIps: string[];
    /** ARM ID of the hosting subnet. */
    hostedSubnetId: string | undefined;
    /** IDs of the router's BGP peerings. */
    peeringIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure virtual router — the original (`virtualRouters`) API of Azure
 * Route Server, which exchanges BGP routes between NVAs and the virtual
 * network. New deployments should prefer the virtual hub API
 * ({@link VirtualHub} without a WAN + {@link VirtualHubIpConfiguration}).
 * About $0.45/hour; ~20 minutes to provision.
 *
 * @see https://learn.microsoft.com/azure/route-server/overview
 *
 * ### Creating a Router
 * **Example:** Router in a RouteServerSubnet
 * ```typescript
 * const router = yield* Azure.Network.VirtualRouter("router", {
 *   resourceGroup: group.resourceGroupName,
 *   hostedSubnetId: routeServerSubnet.subnetId,
 * });
 * ```
 *
 * @resource
 */
export const VirtualRouter = Resource<VirtualRouter>(
  "Azure.Network.VirtualRouter",
);

export const VirtualRouterProvider = () =>
  Provider.succeed(
    VirtualRouter,
    networkProvider<VirtualRouter>()({
      label: "virtual router",
      nameAttr: "virtualRouterName",
      tracked: true,
      slow: true,
      deleteFirst: true,
      immutable: (news, output) =>
        news.hostedSubnetId !== undefined &&
        output.hostedSubnetId !== undefined &&
        !sameId(news.hostedSubnetId, output.hostedSubnetId),
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetVirtualRouter({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualRouterName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.VirtualRoutersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualRouterName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteVirtualRouter({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualRouterName: path.name,
        }),
      listAll: (subscriptionId) => network.ListVirtualRouters({ subscriptionId }),
      body: (news, { location, tags }) => ({
        location,
        tags,
        properties: {
          hostedSubnet: ref(news.hostedSubnetId),
          hostedGateway: ref(news.hostedGatewayId),
        },
      }),
      toAttrs: (path, observed) => ({
        virtualRouterName: path.name,
        virtualRouterId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        virtualRouterAsn: observed.properties?.virtualRouterAsn,
        virtualRouterIps: [...(observed.properties?.virtualRouterIps ?? [])],
        hostedSubnetId: observed.properties?.hostedSubnet?.id,
        peeringIds: idsOf(observed.properties?.peerings),
        tags: userTags(observed.tags),
      }),
      dependsOn: ["Azure.Network.Subnet"],
    }),
  );
