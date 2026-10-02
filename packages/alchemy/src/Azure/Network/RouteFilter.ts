import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface RouteFilterProps {
  /** Resource group of the route filter. Changing it replaces the filter. */
  resourceGroup: string;
  /**
   * Name of the route filter: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the filter.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the filter.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface RouteFilter extends Resource<
  "Azure.Network.RouteFilter",
  RouteFilterProps,
  {
    /** Name of the route filter. */
    routeFilterName: string;
    /** ARM resource ID of the route filter. */
    routeFilterId: string;
    /** Resource group of the route filter. */
    resourceGroup: string;
    /** Location of the route filter. */
    location: string;
    /** Names of the filter's rules. */
    ruleNames: string[];
    /** IDs of the ExpressRoute Microsoft peerings using the filter. */
    peeringIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure route filter — selects which Microsoft 365 / Azure regional BGP
 * communities an ExpressRoute Microsoft peering receives. Add rules with
 * {@link RouteFilterRule}. Route filters are free.
 *
 * @see https://learn.microsoft.com/azure/expressroute/how-to-routefilter-portal
 *
 * ### Creating a Route Filter
 * **Example:** Filter with an allow rule
 * ```typescript
 * const filter = yield* Azure.Network.RouteFilter("m365", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Network.RouteFilterRule("exchange", {
 *   resourceGroup: group.resourceGroupName,
 *   routeFilter: filter.routeFilterName,
 *   communities: ["12076:51004"],
 * });
 * ```
 *
 * @resource
 */
export const RouteFilter = Resource<RouteFilter>("Azure.Network.RouteFilter");

export const RouteFilterProvider = () =>
  Provider.succeed(
    RouteFilter,
    networkProvider<RouteFilter>()({
      label: "route filter",
      nameAttr: "routeFilterName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetRouteFilter({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            routeFilterName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.RouteFiltersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          routeFilterName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteRouteFilter({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          routeFilterName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateRouteFilterTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          routeFilterName: path.name,
          tags,
        }),
      listAll: (subscriptionId) => network.ListRouteFilters({ subscriptionId }),
      // The PUT replaces the rule collection: carry the observed rules
      // (managed by RouteFilterRule).
      body: (_news, { location, tags, observed }) => ({
        location,
        tags,
        properties: {
          rules: (observed?.properties?.rules ?? []).map((rule) => ({
            name: rule.name,
            properties: rule.properties && {
              access: rule.properties.access,
              routeFilterRuleType: rule.properties.routeFilterRuleType,
              communities: rule.properties.communities,
            },
          })),
        },
      }),
      // Only tags are mutable.
      drifted: () => false,
      toAttrs: (path, observed) => ({
        routeFilterName: path.name,
        routeFilterId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        ruleNames: (observed.properties?.rules ?? []).flatMap((rule) =>
          rule.name === undefined ? [] : [rule.name],
        ),
        peeringIds: idsOf(observed.properties?.peerings),
        tags: userTags(observed.tags),
      }),
    }),
  );
