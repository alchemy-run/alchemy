import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle } from "./Entity.ts";

export interface ApiWikiProps {
  /** Resource group of the API Management service. Changing it replaces the wiki. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the wiki. */
  serviceName: string;
  /** Identifier of the API. Changing it replaces the wiki. */
  apiName: string;
  /**
   * Identifiers of the {@link Documentation} pages shown in the API's wiki,
   * in order.
   * @default []
   */
  documents?: string[];
}

export interface ApiWiki extends Resource<
  "Azure.ApiManagement.ApiWiki",
  ApiWikiProps,
  {
    /** ARM resource ID of the wiki. */
    wikiId: string;
    /** Identifier of the API. */
    apiName: string;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Identifiers of the documentation pages in the wiki. */
    documents: string[];
  },
  never,
  Providers
> {}

/**
 * The wiki of an API in API Management: an ordered list of
 * {@link Documentation} pages shown with the API in the developer portal.
 * There is one per API.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/api-wiki
 *
 * ### Attaching Documentation
 * **Example:** Show a getting-started page with an API
 * ```typescript
 * const page = yield* Azure.ApiManagement.Documentation("getting-started", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   title: "Getting started",
 *   content: "# Getting started\nCall `GET /orders`.",
 * });
 * yield* Azure.ApiManagement.ApiWiki("orders-wiki", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   documents: [page.documentationName],
 * });
 * ```
 *
 * @resource
 */
export const ApiWiki = Resource<ApiWiki>("Azure.ApiManagement.ApiWiki");

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
}

const documentIds = (wiki: apim.GetApiWikiResponse) =>
  (wiki.properties?.documents ?? []).flatMap((doc) =>
    doc.documentationId === undefined ? [] : [doc.documentationId],
  );

export const ApiWikiProvider = () =>
  Provider.succeed(ApiWiki, {
    stables: ["wikiId", "apiName", "serviceName", "resourceGroup"],
    ...entityLifecycle<
      ApiWikiProps,
      ApiWiki["Attributes"],
      Key,
      apim.GetApiWikiResponse
    >({
      label: (key) => `API Management wiki of API ${key.apiName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          apiName: props.apiName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetApiWiki({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
        }),
      put: (subscriptionId, key, news) =>
        apim.ApiWikiCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          properties: {
            documents: (news.documents ?? []).map((documentationId) => ({
              documentationId,
            })),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteApiWiki({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
        }),
      inSync: (news, observed) =>
        documentIds(observed).join("\n") === (news.documents ?? []).join("\n"),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        wikiId: observed.id ?? "",
        documents: documentIds(observed),
      }),
    }),
  });
