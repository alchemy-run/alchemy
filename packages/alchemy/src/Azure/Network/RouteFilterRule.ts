import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface RouteFilterRuleProps {
  /** Resource group of the route filter. Changing it replaces the rule. */
  resourceGroup: string;
  /** Name of the parent route filter. Changing it replaces the rule. */
  routeFilter: string;
  /**
   * Name of the rule. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the rule.
   */
  name?: string;
  /**
   * Whether matching communities are allowed. Azure supports only
   * `Allow`.
   * @default "Allow"
   */
  access?: "Allow" | "Deny";
  /** BGP community values to match, e.g. `["12076:51004"]`. */
  communities: string[];
}

export interface RouteFilterRule extends Resource<
  "Azure.Network.RouteFilterRule",
  RouteFilterRuleProps,
  {
    /** Name of the rule. */
    ruleName: string;
    /** ARM resource ID of the rule. */
    ruleId: string;
    /** Name of the parent route filter. */
    routeFilter: string;
    /** Resource group of the route filter. */
    resourceGroup: string;
    /** Access of the rule. */
    access: string | undefined;
    /** BGP communities the rule matches. */
    communities: string[];
  },
  never,
  Providers
> {}

/**
 * A rule in an Azure route filter — the BGP communities an ExpressRoute
 * Microsoft peering may receive. A route filter holds one rule; community
 * values must be current (retired service communities fail provisioning). Rules
 * carry no tags: ownership follows the parent route filter.
 *
 * @see https://learn.microsoft.com/azure/expressroute/how-to-routefilter-portal
 *
 * ### Creating a Rule
 * **Example:** Allow the East US Azure regional community
 * ```typescript
 * yield* Azure.Network.RouteFilterRule("exchange", {
 *   resourceGroup: group.resourceGroupName,
 *   routeFilter: filter.routeFilterName,
 *   communities: ["12076:51004"],
 * });
 * ```
 *
 * @resource
 */
export const RouteFilterRule = Resource<RouteFilterRule>(
  "Azure.Network.RouteFilterRule",
);

export const RouteFilterRuleProvider = () =>
  Provider.succeed(
    RouteFilterRule,
    networkProvider<RouteFilterRule>()({
      label: "route filter rule",
      nameAttr: "ruleName",
      parents: ["routeFilter"],
      tracked: false,
      deleteFirst: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetRouteFilterRule({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            routeFilterName: path.routeFilter!,
            ruleName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.RouteFilterRulesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          routeFilterName: path.routeFilter!,
          ruleName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteRouteFilterRule({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          routeFilterName: path.routeFilter!,
          ruleName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetRouteFilter({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            routeFilterName: path.routeFilter!,
          }),
        ).pipe(Effect.map((filter) => filter?.tags)),
      body: (news) => ({
        properties: {
          access: news.access ?? "Allow",
          routeFilterRuleType: "Community",
          communities: news.communities,
        },
      }),
      drifted: (observed, _body, news) =>
        (observed.properties?.access ?? "Allow") !== (news.access ?? "Allow") ||
        !sameSet(observed.properties?.communities, news.communities),
      toAttrs: (path, observed) => ({
        ruleName: path.name,
        ruleId: observed.id ?? "",
        routeFilter: path.routeFilter!,
        resourceGroup: path.resourceGroup,
        access: observed.properties?.access,
        communities: [...(observed.properties?.communities ?? [])],
      }),
      dependsOn: ["Azure.Network.RouteFilter"],
    }),
  );
