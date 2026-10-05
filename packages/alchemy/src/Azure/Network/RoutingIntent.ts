import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { networkProvider } from "./generic.ts";
import { hubOwnerTags } from "./virtualHubShared.ts";

/** A routing policy: which traffic goes through which security hop. */
export interface RoutingPolicySpec {
  /** Name of the policy, e.g. `"InternetTraffic"` or `"PrivateTrafficPolicy"`. */
  name: string;
  /** Traffic classes: `"Internet"` and/or `"PrivateTraffic"`. */
  destinations: ("Internet" | "PrivateTraffic")[];
  /** ARM ID of the next hop (hub Azure Firewall or NVA). */
  nextHop: string;
}

export interface RoutingIntentProps {
  /** Resource group of the virtual hub. Changing it replaces the intent. */
  resourceGroup: string;
  /** Name of the parent virtual hub. Changing it replaces the intent. */
  virtualHub: string;
  /**
   * Name of the routing intent (one per hub). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * intent.
   */
  name?: string;
  /** Routing policies of the hub. */
  routingPolicies: RoutingPolicySpec[];
}

export interface RoutingIntent extends Resource<
  "Azure.Network.RoutingIntent",
  RoutingIntentProps,
  {
    /** Name of the routing intent. */
    routingIntentName: string;
    /** ARM resource ID of the routing intent. */
    routingIntentId: string;
    /** Name of the parent virtual hub. */
    virtualHub: string;
    /** Resource group of the virtual hub. */
    resourceGroup: string;
    /** Names of the routing policies. */
    policyNames: string[];
  },
  never,
  Providers
> {}

/**
 * The routing intent of a secured Azure Virtual WAN hub — sends internet
 * and/or private traffic through the hub's Azure Firewall or security NVA.
 * Requires a firewall or NVA deployed in the hub. Routing intents carry no
 * tags: ownership follows the parent hub.
 *
 * @see https://learn.microsoft.com/azure/virtual-wan/how-to-routing-policies
 *
 * ### Securing a Hub
 * **Example:** Internet and private traffic through the hub firewall
 * ```typescript
 * yield* Azure.Network.RoutingIntent("intent", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHub: hub.virtualHubName,
 *   routingPolicies: [
 *     { name: "InternetTraffic", destinations: ["Internet"], nextHop: firewall.azureFirewallId },
 *     { name: "PrivateTraffic", destinations: ["PrivateTraffic"], nextHop: firewall.azureFirewallId },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const RoutingIntent = Resource<RoutingIntent>(
  "Azure.Network.RoutingIntent",
);

export const RoutingIntentProvider = () =>
  Provider.succeed(
    RoutingIntent,
    networkProvider<RoutingIntent>()({
      label: "routing intent",
      nameAttr: "routingIntentName",
      parents: ["virtualHub"],
      tracked: false,
      slow: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetRoutingIntent({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            virtualHubName: path.virtualHub!,
            routingIntentName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.RoutingIntentCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          routingIntentName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteRoutingIntent({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          virtualHubName: path.virtualHub!,
          routingIntentName: path.name,
        }),
      ownerTags: hubOwnerTags,
      body: (news) => ({
        properties: { routingPolicies: news.routingPolicies },
      }),
      toAttrs: (path, observed) => ({
        routingIntentName: path.name,
        routingIntentId: observed.id ?? "",
        virtualHub: path.virtualHub!,
        resourceGroup: path.resourceGroup,
        policyNames: (observed.properties?.routingPolicies ?? []).map(
          (policy) => policy.name,
        ),
      }),
      dependsOn: ["Azure.Network.VirtualHub", "Azure.Network.AzureFirewall"],
    }),
  );
