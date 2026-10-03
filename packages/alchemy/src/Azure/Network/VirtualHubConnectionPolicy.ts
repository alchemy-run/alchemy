import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import {
  hubOwnerTags,
  routingConfigurationInput,
  type HubRoutingConfiguration,
} from "./virtualHubShared.ts";

export interface VirtualHubConnectionPolicyProps {
  /** Resource group of the virtual hub. Changing it replaces the policy. */
  resourceGroup: string;
  /** Name of the parent virtual hub. Changing it replaces the policy. */
  virtualHub: string;
  /**
   * Name of the connection policy. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Route internet traffic of associated connections through the hub's
   * secured edge.
   * @default false
   */
  enableInternetSecurity?: boolean;
  /** Routing applied to the associated connections. */
  routing?: HubRoutingConfiguration;
}

export interface VirtualHubConnectionPolicy extends Resource<
  "Azure.Network.VirtualHubConnectionPolicy",
  VirtualHubConnectionPolicyProps,
  {
    /** Name of the connection policy. */
    connectionPolicyName: string;
    /** ARM resource ID of the connection policy. */
    connectionPolicyId: string;
    /** Name of the parent virtual hub. */
    virtualHub: string;
    /** Resource group of the virtual hub. */
    resourceGroup: string;
    /** IDs of the connections that use the policy. */
    associatedConnectionIds: string[];
  },
  never,
  Providers
> {}

/**
 * A reusable connection policy of an Azure Virtual WAN hub (preview) —
 * shared routing and internet-security settings that hub connections
 * reference instead of configuring them one by one. Policies carry no
 * tags: ownership follows the parent hub.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/about-virtual-hub-routing
 *
 * ### Creating a Connection Policy
 * **Example:** Spokes associated with a custom table
 * ```typescript
 * yield* Azure.Network.VirtualHubConnectionPolicy("spokes", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHub: hub.virtualHubName,
 *   routing: {
 *     associatedRouteTableId: table.routeTableId,
 *     propagatedLabels: ["default"],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const VirtualHubConnectionPolicy = Resource<VirtualHubConnectionPolicy>(
  "Azure.Network.VirtualHubConnectionPolicy",
);

export const VirtualHubConnectionPolicyProvider = () =>
  Provider.succeed(
    VirtualHubConnectionPolicy,
    networkProvider<VirtualHubConnectionPolicy>()({
      label: "virtual hub connection policy",
      nameAttr: "connectionPolicyName",
      parents: ["virtualHub"],
      tracked: false,
      slow: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetConnectionPolicy({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualHubName: path.virtualHub!,
            connectionPolicyName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ConnectionPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          connectionPolicyName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteConnectionPolicy({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          connectionPolicyName: path.name,
        }),
      ownerTags: hubOwnerTags,
      body: (news) => ({
        properties: {
          enableInternetSecurity: news.enableInternetSecurity ?? false,
          routingConfiguration: routingConfigurationInput(news.routing),
        },
      }),
      toAttrs: (path, observed) => ({
        connectionPolicyName: path.name,
        connectionPolicyId: observed.id ?? "",
        virtualHub: path.virtualHub!,
        resourceGroup: path.resourceGroup,
        associatedConnectionIds: [
          ...(observed.properties?.associatedConnections ?? []),
        ],
      }),
      dependsOn: ["Azure.Network.VirtualHub"],
    }),
  );
