import * as cdn from "@distilled.cloud/azure/cdn";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  AFD_DELETE_BUDGET,
  changedFields,
  createAfdName,
  profileOwnedByStack,
  sameName,
  waitForAfd,
  whileOriginGroupNotReady,
  whileProfileBusy,
} from "./CdnCommon.ts";

export interface AfdRouteCacheConfiguration {
  /** How query strings affect the cache key. */
  queryStringCachingBehavior?:
    | "IgnoreQueryString"
    | "UseQueryString"
    | "IgnoreSpecifiedQueryStrings"
    | "IncludeSpecifiedQueryStrings";
  /** Comma-separated query parameters to include or ignore. */
  queryParameters?: string;
  /** Compression settings. */
  compressionSettings?: {
    /** MIME types to compress. */
    contentTypesToCompress?: string[];
    /** Whether Front Door compresses responses. */
    isCompressionEnabled?: boolean;
  };
}

export interface RouteProps {
  /** Resource group of the profile. Changing it replaces the route. */
  resourceGroup: string;
  /** Front Door profile that holds the endpoint. Changing it replaces the route. */
  profile: string;
  /** Endpoint the route belongs to. Changing it replaces the route. */
  endpoint: string;
  /**
   * Route name: letters, digits, and hyphens, unique in the endpoint. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the route.
   */
  name?: string;
  /** ARM ID of the origin group traffic is forwarded to (`AfdOriginGroup.originGroupId`). */
  originGroupId: string;
  /** ARM IDs of custom domains served by the route (`AfdCustomDomain.customDomainId`). */
  customDomainIds?: string[];
  /** ARM IDs of rule sets applied by the route (`RuleSet.ruleSetId`). */
  ruleSetIds?: string[];
  /** Path prefix prepended on the origin, e.g. `/static`. */
  originPath?: string;
  /** Protocols the route accepts. @default ["Http", "Https"] */
  supportedProtocols?: ("Http" | "Https")[];
  /** Path patterns the route matches. @default ["/*"] */
  patternsToMatch?: string[];
  /** Caching configuration. Omit to disable caching. */
  cacheConfiguration?: AfdRouteCacheConfiguration;
  /** Protocol used to reach the origin. @default "MatchRequest" */
  forwardingProtocol?: "HttpOnly" | "HttpsOnly" | "MatchRequest";
  /** Serve the route on the endpoint's `*.azurefd.net` host. @default "Enabled" */
  linkToDefaultDomain?: "Enabled" | "Disabled";
  /** Redirect HTTP to HTTPS. @default "Enabled" */
  httpsRedirect?: "Enabled" | "Disabled";
  /** Whether the route is active. @default "Enabled" */
  enabledState?: "Enabled" | "Disabled";
}

export interface Route extends Resource<
  "Azure.Cdn.Route",
  RouteProps,
  {
    /** Name of the route. */
    routeName: string;
    /** ARM resource ID of the route. */
    routeId: string;
    /** Endpoint that holds the route. */
    endpoint: string;
    /** Front Door profile that holds the endpoint. */
    profile: string;
    /** Resource group of the profile. */
    resourceGroup: string;
    /** Edge deployment status. */
    deploymentStatus: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Front Door route — maps an endpoint's (and custom domains') path
 * patterns to an origin group, with optional caching, HTTPS redirect, and
 * rule sets. The origin group needs at least one origin first.
 *
 * @see https://learn.microsoft.com/azure/frontdoor/front-door-route-matching
 *
 * ### Creating a Route
 * **Example:** Route all traffic to an origin group
 * ```typescript
 * const route = yield* Azure.Cdn.Route("default", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 * });
 * ```
 *
 * **Example:** Cached static assets over HTTPS only
 * ```typescript
 * const assets = yield* Azure.Cdn.Route("assets", {
 *   resourceGroup: group.resourceGroupName,
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   patternsToMatch: ["/assets/*"],
 *   forwardingProtocol: "HttpsOnly",
 *   cacheConfiguration: {
 *     queryStringCachingBehavior: "IgnoreQueryString",
 *     compressionSettings: {
 *       isCompressionEnabled: true,
 *       contentTypesToCompress: ["text/css", "application/javascript"],
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Route = Resource<Route>("Azure.Cdn.Route");

const createRouteName = (id: string) => createAfdName(id, 50);

const getRoute = (
  subscriptionId: string,
  resourceGroupName: string,
  profileName: string,
  endpointName: string,
  routeName: string,
) =>
  orUndefinedIfNotFound(
    cdn.GetRoute({
      subscriptionId,
      resourceGroupName,
      profileName,
      endpointName,
      routeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  endpoint: string,
  name: string,
  route: cdn.GetRouteResponse,
): Route["Attributes"] => ({
  routeName: name,
  routeId: route.id ?? "",
  endpoint,
  profile,
  resourceGroup,
  deploymentStatus: route.properties?.deploymentStatus,
});

/** Whether two routes on one endpoint share a path pattern and protocol. */
const routesOverlap = (news: RouteProps, olds: RouteProps | undefined) => {
  if (olds === undefined) return true;
  const intersects = (a: readonly string[], b: readonly string[]) =>
    a.some((x) => b.some((y) => x.toLowerCase() === y.toLowerCase()));
  const defaultProtocols = ["Http", "Https"];
  return (
    intersects(news.patternsToMatch ?? ["/*"], olds.patternsToMatch ?? ["/*"]) &&
    intersects(
      news.supportedProtocols ?? defaultProtocols,
      olds.supportedProtocols ?? defaultProtocols,
    )
  );
};

const desiredProperties = (news: RouteProps) => ({
  originGroup: { id: news.originGroupId },
  customDomains: (news.customDomainIds ?? []).map((id) => ({ id })),
  ruleSets: (news.ruleSetIds ?? []).map((id) => ({ id })),
  originPath: news.originPath,
  supportedProtocols: news.supportedProtocols ?? ["Http", "Https"],
  patternsToMatch: news.patternsToMatch ?? ["/*"],
  cacheConfiguration: news.cacheConfiguration,
  forwardingProtocol: news.forwardingProtocol ?? "MatchRequest",
  linkToDefaultDomain: news.linkToDefaultDomain ?? "Enabled",
  httpsRedirect: news.httpsRedirect ?? "Enabled",
  enabledState: news.enabledState ?? "Enabled",
});

export const RouteProvider = () =>
  Provider.succeed(Route, {
    stables: ["routeName", "routeId", "endpoint", "profile", "resourceGroup"],

    // Routes are deleted with their endpoint and profile.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameEndpoint =
        sameName(news.resourceGroup, output.resourceGroup) &&
        sameName(news.profile, output.profile) &&
        sameName(news.endpoint, output.endpoint);
      if (
        !sameEndpoint ||
        (news.name !== undefined && !sameName(news.name, output.routeName))
      ) {
        // An endpoint rejects two routes matching the same path pattern and
        // protocol: a renamed route that keeps an overlapping match can only
        // be created after the old one is gone.
        return {
          action: "replace",
          deleteFirst: sameEndpoint && routesOverlap(news, olds),
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile = output?.profile ?? olds?.profile;
      const endpoint = output?.endpoint ?? olds?.endpoint;
      if (
        resourceGroup === undefined ||
        profile === undefined ||
        endpoint === undefined
      ) {
        return undefined;
      }
      const name =
        output?.routeName ?? olds?.name ?? (yield* createRouteName(id));
      const observed = yield* getRoute(
        subscriptionId,
        resourceGroup,
        profile,
        endpoint,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, endpoint, name, observed);
      return (yield* profileOwnedByStack(
        subscriptionId,
        resourceGroup,
        profile,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile, endpoint } = news;
      const name =
        news.name ?? output?.routeName ?? (yield* createRouteName(id));
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: profile,
        endpointName: endpoint,
        routeName: name,
      };
      const get = getRoute(
        subscriptionId,
        resourceGroup,
        profile,
        endpoint,
        name,
      );
      const label = `Front Door route ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cdn
          .CreateRoute({ ...where, properties })
          .pipe(Effect.retry(whileOriginGroupNotReady));
      }
      observed = yield* waitForAfd(
        label,
        get,
        (r) => r.properties?.provisioningState,
      );

      // Sync routing settings against observed state.
      const changed = changedFields(properties, observed.properties);
      if (Object.keys(changed).length > 0) {
        yield* cdn
          .UpdateRoute({ ...where, properties: changed })
          .pipe(Effect.retry(whileOriginGroupNotReady));
        observed = yield* waitForAfd(
          label,
          get,
          (r) => r.properties?.provisioningState,
        );
      }

      return toAttrs(resourceGroup, profile, endpoint, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cdn
          .DeleteRoute({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            profileName: output.profile,
            endpointName: output.endpoint,
            routeName: output.routeName,
          })
          .pipe(Effect.retry(whileProfileBusy)),
      );
      yield* waitUntilGone(
        `Front Door route ${output.routeName}`,
        getRoute(
          subscriptionId,
          output.resourceGroup,
          output.profile,
          output.endpoint,
          output.routeName,
        ),
        AFD_DELETE_BUDGET,
      );
    }),
  });
