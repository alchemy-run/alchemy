import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { sameName } from "./Common.ts";
import { entityLifecycle, reveal } from "./Entity.ts";

export interface CacheProps {
  /** Resource group of the API Management service. Changing it replaces the cache. */
  resourceGroup: string;
  /** API Management service that uses the cache. Changing it replaces the cache. */
  serviceName: string;
  /**
   * Cache identifier: `default`, or an Azure region (e.g. `westus2`) for a
   * cache used by the gateway in that region. Changing it replaces the
   * cache entity.
   * @default "default"
   */
  name?: string;
  /** Redis connection string, e.g. `host:6380,password=...,ssl=True,abortConnect=False`. */
  connectionString: Redacted.Redacted<string>;
  /**
   * Region whose gateway uses the cache, or `default`.
   * @default "default"
   */
  useFromLocation?: string;
  /**
   * ARM resource ID of the Azure Cache for Redis instance (for portal linking).
   * @default not set
   */
  resourceId?: string;
  /**
   * Description of the cache.
   * @default no description
   */
  description?: string;
}

export interface Cache extends Resource<
  "Azure.ApiManagement.Cache",
  CacheProps,
  {
    /** Cache identifier (`default` or a region). */
    cacheName: string;
    /** ARM resource ID of the cache entity. */
    cacheId: string;
    /** API Management service that uses the cache. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Region whose gateway uses the cache. */
    useFromLocation: string;
  },
  never,
  Providers
> {}

/**
 * An external Redis-compatible cache for API Management's `cache-lookup`
 * / `cache-store` policies. Required on the Consumption tier (which has no
 * built-in cache) and optional elsewhere.
 * The ARM type is `Microsoft.ApiManagement/service/caches`.
 *
 * :::caution
 * Changing `serviceName`, `name`, or `resourceGroup` replaces the cache.
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-cache-external
 *
 * ### Using an External Cache
 * **Example:** Point the gateway at Azure Cache for Redis
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const redis = yield* Azure.Redis.Cache("cache");
 * yield* Azure.ApiManagement.Cache("redis", {
 *   serviceName: apim.serviceName,
 *   // host:6380,password=<key>,ssl=True,abortConnect=False
 *   connectionString: yield* Config.redacted("REDIS_CONNECTION_STRING"),
 *   resourceId: redis.cacheId,
 *   description: "Response cache",
 * });
 * ```
 *
 * @resource
 */
export const Cache = GroupedResource<Cache>("Azure.ApiManagement.Cache");

interface Key {
  resourceGroup: string;
  serviceName: string;
  cacheName: string;
}

export const CacheProvider = () =>
  Provider.succeed(Cache, {
    stables: ["cacheName", "cacheId", "serviceName", "resourceGroup"],
    ...entityLifecycle<CacheProps, Cache["Attributes"], Key, apim.GetCacheResponse>({
      label: (key) => `API Management cache ${key.cacheName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          cacheName: props.name ?? "default",
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetCache({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          cacheId: key.cacheName,
        }),
      put: (subscriptionId, key, news) =>
        apim.CacheCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          cacheId: key.cacheName,
          properties: {
            connectionString: news.connectionString,
            useFromLocation: news.useFromLocation ?? "default",
            resourceId: news.resourceId,
            description: news.description,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteCache({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          cacheId: key.cacheName,
        }),
      // GET masks the connection string; compare it to the last deploy.
      inSync: (news, observed, olds) =>
        olds !== undefined &&
        reveal(olds.connectionString) === reveal(news.connectionString) &&
        sameName(observed.properties?.useFromLocation, news.useFromLocation ?? "default") &&
        (news.description === undefined || observed.properties?.description === news.description) &&
        (news.resourceId === undefined ||
          sameName(observed.properties?.resourceId, news.resourceId)),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        cacheName: key.cacheName,
        cacheId: observed.id ?? "",
        useFromLocation: observed.properties?.useFromLocation ?? "default",
      }),
    }),
  });
