import * as apim from "@distilled.cloud/azure/apimanagement";
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
  createEntityName,
  isParentOwned,
  sameName,
  subsetMatches,
} from "./Common.ts";

export type VersioningScheme = apim.ApiVersionSetContractPropertiesVersioningScheme;

export interface ApiVersionSetProps {
  /** Resource group of the API Management service. Changing it replaces the version set. */
  resourceGroup: string;
  /** API Management service that holds the version set. Changing it replaces the version set. */
  serviceName: string;
  /**
   * Version set identifier (1-80 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the version set.
   */
  name?: string;
  /**
   * Display name of the version set.
   * @default the version set identifier
   */
  displayName?: string;
  /**
   * Where callers put the API version: a path segment (`/v1/...`), a query
   * parameter, or a header.
   */
  versioningScheme: VersioningScheme;
  /** Query parameter that carries the version. Required when `versioningScheme` is `Query`. */
  versionQueryName?: string;
  /** Header that carries the version. Required when `versioningScheme` is `Header`. */
  versionHeaderName?: string;
  /** Description of the version set. */
  description?: string;
}

export interface ApiVersionSet extends Resource<
  "Azure.ApiManagement.ApiVersionSet",
  ApiVersionSetProps,
  {
    /** Version set identifier. */
    versionSetName: string;
    /** ARM resource ID of the version set; pass it as an API's `apiVersionSetId`. */
    versionSetId: string;
    /** API Management service that holds the version set. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name. */
    displayName: string;
    /** Versioning scheme. */
    versioningScheme: string;
  },
  never,
  Providers
> {}

/**
 * An API Management version set — groups the versions of an API and
 * defines how callers select a version (path segment, query parameter, or
 * header).
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-versions
 *
 * ### Creating a Version Set
 * **Example:** Path-segment versioning (`/hello/v1/...`)
 * ```typescript
 * const versions = yield* Azure.ApiManagement.ApiVersionSet("hello", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "Hello",
 *   versioningScheme: "Segment",
 * });
 * ```
 *
 * **Example:** Header versioning
 * ```typescript
 * const versions = yield* Azure.ApiManagement.ApiVersionSet("hello", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   versioningScheme: "Header",
 *   versionHeaderName: "api-version",
 * });
 * ```
 *
 * @resource
 */
export const ApiVersionSet = Resource<ApiVersionSet>(
  "Azure.ApiManagement.ApiVersionSet",
);

const getVersionSet = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  versionSetId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetApiVersionSet({
      subscriptionId,
      resourceGroupName,
      serviceName,
      versionSetId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  set: apim.GetApiVersionSetResponse,
): ApiVersionSet["Attributes"] => ({
  versionSetName: name,
  versionSetId: set.id ?? "",
  serviceName,
  resourceGroup,
  displayName: set.properties?.displayName ?? name,
  versioningScheme: set.properties?.versioningScheme ?? "",
});

export const ApiVersionSetProvider = () =>
  Provider.succeed(ApiVersionSet, {
    stables: ["versionSetName", "versionSetId", "serviceName", "resourceGroup"],

    // Version sets live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        (news.name !== undefined && !sameName(news.name, output.versionSetName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name =
        output?.versionSetName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getVersionSet(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ?? output?.versionSetName ?? (yield* createEntityName(id));
      const desired: apim.ApiVersionSetContractProperties = {
        displayName: news.displayName ?? name,
        versioningScheme: news.versioningScheme,
        versionQueryName: news.versionQueryName,
        versionHeaderName: news.versionHeaderName,
        description: news.description,
      };

      // Observe, then create or sync with one upsert when anything differs.
      const observed = yield* getVersionSet(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      const current =
        observed !== undefined && subsetMatches(desired, observed.properties)
          ? observed
          : yield* apim.ApiVersionSetCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              serviceName,
              versionSetId: name,
              properties: desired,
            });
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteApiVersionSet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          versionSetId: output.versionSetName,
        }),
      );
      yield* waitUntilGone(
        `API Management version set ${output.versionSetName}`,
        getVersionSet(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.versionSetName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
