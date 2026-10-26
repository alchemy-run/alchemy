import * as cdn from "@distilled.cloud/azure/cdn";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { ensureRegistered, ignoreNotFound, orUndefinedIfNotFound, waitUntilGone } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
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
  /**
   * How query strings affect the cache key: ignore them, use the whole
   * query string, or ignore or include only the `queryParameters`.
   */
  queryStringCachingBehavior?:
    | "IgnoreQueryString"
    | "UseQueryString"
    | "IgnoreSpecifiedQueryStrings"
    | "IncludeSpecifiedQueryStrings";
  /**
   * Comma-separated query parameters to include or ignore, e.g. `v,lang`,
   * for the `*SpecifiedQueryStrings` behaviors.
   */
  queryParameters?: string;
  /** Compression settings. @default no compression */
  compressionSettings?: {
    /** MIME types to compress, e.g. `text/html` or `application/json`. */
    contentTypesToCompress?: string[];
    /** Whether Front Door compresses responses at the edge. */
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
  /**
   * ARM ID of the origin group traffic is forwarded to
   * (`AfdOriginGroup.originGroupId`). Changing it updates the route in
   * place.
   */
  originGroupId: string;
  /**
   * ARM IDs of custom domains served by the route
   * (`AfdCustomDomain.customDomainId`).
   * @default []
   */
  customDomainIds?: string[];
  /**
   * ARM IDs of rule sets applied by the route (`RuleSet.ruleSetId`).
   * @default []
   */
  ruleSetIds?: string[];
  /**
   * Path prefix prepended on the origin, e.g. `/static` sends `/app.js` to
   * the origin as `/static/app.js`.
   * @default no prefix
   */
  originPath?: string;
  /** Protocols the route accepts. @default ["Http", "Https"] */
  supportedProtocols?: ("Http" | "Https")[];
  /** Path patterns the route matches. @default ["/*"] */
  patternsToMatch?: string[];
  /**
   * Caching configuration. Omit to disable caching: Front Door then
   * forwards every request to the origin.
   * @default no caching
   */
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
 * A Front Door route (`Microsoft.Cdn/profiles/afdEndpoints/routes`): maps
 * the path patterns of an endpoint and its custom domains to an origin
 * group, with optional caching, compression, and rule sets.
 *
 * By default a route matches `/*` over HTTP and HTTPS, redirects HTTP to
 * HTTPS, forwards with the request's protocol, serves on the endpoint's
 * `*.azurefd.net` host, and does not cache.
 *
 * :::caution[Changing `name`, `endpoint`, `profile`, or `resourceGroup` replaces the route]
 * Alchemy creates the new route and deletes the old one. An endpoint
 * rejects two routes that match the same pattern and protocol, so when a
 * renamed route keeps an overlapping match, Alchemy deletes the old route
 * first: those paths return errors until the new route deploys.
 * :::
 *
 * :::caution[The origin group needs an enabled origin]
 * Front Door rejects a route whose origin group has no enabled, deployed
 * origin (`AfdOriginGroupNotReady`). Alchemy retries for up to 10 minutes
 * while a sibling `Azure.Cdn.AfdOrigin` deploys.
 * :::
 *
 * @see https://learn.microsoft.com/azure/frontdoor/front-door-route-matching
 *
 * ### Creating a Route
 * **Example:** Route all traffic to an origin group
 * ```typescript
 * const profile = yield* Azure.Cdn.Profile("cdn");
 * const endpoint = yield* Azure.Cdn.AfdEndpoint("web", {
 *   profile: profile.profileName,
 * });
 * const origins = yield* Azure.Cdn.AfdOriginGroup("app", {
 *   profile: profile.profileName,
 * });
 * yield* Azure.Cdn.AfdOrigin("app", {
 *   profile: profile.profileName,
 *   originGroup: origins.originGroupName,
 *   hostName: "app.contoso.com",
 * });
 * const route = yield* Azure.Cdn.Route("default", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 * });
 * ```
 *
 * ### Path Patterns
 * Front Door picks the route with the most specific matching pattern. Use
 * several routes on one endpoint to send paths to different origin
 * groups.
 *
 * **Example:** API to a Web App, everything else to a static site
 * ```typescript
 * const api = yield* Azure.Web.WebApp("Api", { main: "./src/api.ts" });
 * const apiOrigins = yield* Azure.Cdn.AfdOriginGroup("api", {
 *   profile: profile.profileName,
 * });
 * yield* Azure.Cdn.AfdOrigin("api", {
 *   profile: profile.profileName,
 *   originGroup: apiOrigins.originGroupName,
 *   hostName: api.defaultHostName,
 * });
 * const siteOrigins = yield* Azure.Cdn.AfdOriginGroup("site", {
 *   profile: profile.profileName,
 * });
 * yield* Azure.Cdn.AfdOrigin("site", {
 *   profile: profile.profileName,
 *   originGroup: siteOrigins.originGroupName,
 *   hostName: "mysite.z13.web.core.windows.net",
 * });
 * yield* Azure.Cdn.Route("api", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: apiOrigins.originGroupId,
 *   patternsToMatch: ["/api/*"],
 * });
 * yield* Azure.Cdn.Route("site", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: siteOrigins.originGroupId,
 *   patternsToMatch: ["/*"],
 * });
 * ```
 *
 * **Example:** Prepend `/public` on the origin
 * ```typescript
 * // GET /media/logo.png → origin GET /public/media/logo.png
 * yield* Azure.Cdn.Route("media", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   patternsToMatch: ["/media/*"],
 *   originPath: "/public",
 * });
 * ```
 *
 * ### Protocols and HTTPS
 * `httpsRedirect` sends HTTP clients a redirect to HTTPS.
 * `forwardingProtocol` sets the protocol Front Door uses to reach the
 * origin.
 *
 * **Example:** HTTPS only, end to end
 * ```typescript
 * yield* Azure.Cdn.Route("default", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   supportedProtocols: ["Https"],
 *   forwardingProtocol: "HttpsOnly",
 * });
 * ```
 *
 * **Example:** HTTP-only origin behind an HTTPS edge
 * ```typescript
 * yield* Azure.Cdn.Route("legacy", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   forwardingProtocol: "HttpOnly",
 *   httpsRedirect: "Enabled",
 * });
 * ```
 *
 * ### Caching and Compression
 * Set `cacheConfiguration` to cache responses at the edge. Without it,
 * Front Door forwards every request to the origin.
 *
 * **Example:** Cached static assets over HTTPS only
 * ```typescript
 * const assets = yield* Azure.Cdn.Route("assets", {
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
 * **Example:** Cache per version and language query parameter
 * ```typescript
 * yield* Azure.Cdn.Route("pages", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   cacheConfiguration: {
 *     queryStringCachingBehavior: "IncludeSpecifiedQueryStrings",
 *     queryParameters: "v,lang",
 *   },
 * });
 * ```
 *
 * ### Custom Domains
 * List custom domains in `customDomainIds`. Set
 * `linkToDefaultDomain: "Disabled"` to serve the route only on those
 * domains and not on the `*.azurefd.net` host.
 *
 * **Example:** Serve only on `www.contoso.com`
 * ```typescript
 * const domain = yield* Azure.Cdn.AfdCustomDomain("www", {
 *   profile: profile.profileName,
 *   hostName: "www.contoso.com",
 * });
 * yield* Azure.Cdn.Route("default", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   customDomainIds: [domain.customDomainId],
 *   linkToDefaultDomain: "Disabled",
 * });
 * ```
 *
 * ### Rule Sets
 * Attach `Azure.Cdn.RuleSet`s to rewrite headers, redirect, or override
 * caching for the route's requests.
 *
 * **Example:** Add a security header to every response
 * ```typescript
 * const rules = yield* Azure.Cdn.RuleSet("headers", {
 *   profile: profile.profileName,
 * });
 * yield* Azure.Cdn.Rule("frameOptions", {
 *   profile: profile.profileName,
 *   ruleSet: rules.ruleSetName,
 *   order: 1,
 *   actions: [
 *     {
 *       name: "ModifyResponseHeader",
 *       parameters: {
 *         typeName: "DeliveryRuleHeaderActionParameters",
 *         headerAction: "Overwrite",
 *         headerName: "X-Frame-Options",
 *         value: "DENY",
 *       },
 *     },
 *   ],
 * });
 * yield* Azure.Cdn.Route("default", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   ruleSetIds: [rules.ruleSetId],
 * });
 * ```
 *
 * ### Disabling a Route
 * **Example:** Stop serving a route without deleting it
 * ```typescript
 * yield* Azure.Cdn.Route("maintenance", {
 *   profile: profile.profileName,
 *   endpoint: endpoint.endpointName,
 *   originGroupId: origins.originGroupId,
 *   patternsToMatch: ["/beta/*"],
 *   enabledState: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const Route = GroupedResource<Route>("Azure.Cdn.Route");

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
      if (!sameEndpoint || (news.name !== undefined && !sameName(news.name, output.routeName))) {
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
      if (resourceGroup === undefined || profile === undefined || endpoint === undefined) {
        return undefined;
      }
      const name = output?.routeName ?? olds?.name ?? (yield* createRouteName(id));
      const observed = yield* getRoute(subscriptionId, resourceGroup, profile, endpoint, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, endpoint, name, observed);
      return (yield* profileOwnedByStack(subscriptionId, resourceGroup, profile))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Cdn");
      const { resourceGroup, profile, endpoint } = news;
      const name = news.name ?? output?.routeName ?? (yield* createRouteName(id));
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        profileName: profile,
        endpointName: endpoint,
        routeName: name,
      };
      const get = getRoute(subscriptionId, resourceGroup, profile, endpoint, name);
      const label = `Front Door route ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* cdn
          .CreateRoute({ ...where, properties })
          .pipe(Effect.retry(whileOriginGroupNotReady));
      }
      observed = yield* waitForAfd(label, get, (r) => r.properties?.provisioningState);

      // Sync routing settings against observed state.
      const changed = changedFields(properties, observed.properties);
      if (Object.keys(changed).length > 0) {
        yield* cdn
          .UpdateRoute({ ...where, properties: changed })
          .pipe(Effect.retry(whileOriginGroupNotReady));
        observed = yield* waitForAfd(label, get, (r) => r.properties?.provisioningState);
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
