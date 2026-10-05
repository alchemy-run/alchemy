import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface ApiReleaseProps {
  /** Resource group of the API Management service. Changing it replaces the release. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the release. */
  serviceName: string;
  /** Identifier of the API (without `;rev=`). Changing it replaces the release. */
  apiName: string;
  /**
   * Release identifier, unique within the API. Changing it replaces the
   * release.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * API revision to make current, e.g. `"2"`. Creating a release makes that
   * revision the current one. Changing it replaces the release.
   * @default the API's current revision
   */
  apiRevision?: string;
  /** Release notes shown in the developer portal change log. */
  notes?: string;
}

export interface ApiRelease extends Resource<
  "Azure.ApiManagement.ApiRelease",
  ApiReleaseProps,
  {
    /** Release identifier within the API. */
    releaseName: string;
    /** ARM resource ID of the release. */
    releaseId: string;
    /** Identifier of the API. */
    apiName: string;
    /** Released API revision (`undefined` for the current one). */
    apiRevision: string | undefined;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Release notes. */
    notes: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A release of an API in API Management. Releasing an API revision makes
 * it the current revision and records an entry (with notes) in the API's
 * change log.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-revisions
 *
 * ### Releasing Revisions
 * **Example:** Make revision 2 current with release notes
 * ```typescript
 * yield* Azure.ApiManagement.ApiRelease("orders-r2", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: "orders",
 *   apiRevision: "2",
 *   notes: "Adds pagination to GET /orders",
 * });
 * ```
 *
 * @resource
 */
export const ApiRelease = Resource<ApiRelease>(
  "Azure.ApiManagement.ApiRelease",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  releaseName: string;
  apiRevision: string | undefined;
}

export const ApiReleaseProvider = () =>
  Provider.succeed(ApiRelease, {
    stables: [
      "releaseName",
      "releaseId",
      "apiName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      ApiReleaseProps,
      ApiRelease["Attributes"],
      Key,
      apim.GetApiReleaseResponse
    >({
      label: (key) =>
        `API Management release ${key.releaseName} of API ${key.apiName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            apiName: props.apiName,
            apiRevision: props.apiRevision,
            releaseName:
              props.name ??
              output?.releaseName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetApiRelease({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          releaseId: key.releaseName,
        }),
      put: (subscriptionId, key, news) =>
        apim.ApiReleaseCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          releaseId: key.releaseName,
          properties: {
            apiId: serviceEntityId(
              subscriptionId,
              key,
              key.apiRevision === undefined
                ? `apis/${key.apiName}`
                : `apis/${key.apiName};rev=${key.apiRevision}`,
            ),
            notes: news.notes,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteApiRelease({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          releaseId: key.releaseName,
        }),
      inSync: (news, observed) =>
        (news.notes ?? "") === (observed.properties?.notes ?? ""),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        apiRevision: key.apiRevision,
        releaseName: key.releaseName,
        releaseId: observed.id ?? "",
        notes: observed.properties?.notes,
      }),
    }),
  });
