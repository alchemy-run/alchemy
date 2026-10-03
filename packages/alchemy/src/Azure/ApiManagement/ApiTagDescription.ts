import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle } from "./Entity.ts";

export interface ApiTagDescriptionProps {
  /** Resource group of the API Management service. Changing it replaces the description. */
  resourceGroup: string;
  /** API Management service that holds the API and tag. Changing it replaces the description. */
  serviceName: string;
  /** Identifier of the API. Changing it replaces the description. */
  apiName: string;
  /** Identifier of the tag being described (`Tag.tagName`). Changing it replaces the description. */
  tagName: string;
  /** Description of the tag in the context of the API (Markdown). */
  description?: string;
  /** URL of external documentation for the tag. */
  externalDocsUrl?: string;
  /** Description of the external documentation. */
  externalDocsDescription?: string;
}

export interface ApiTagDescription extends Resource<
  "Azure.ApiManagement.ApiTagDescription",
  ApiTagDescriptionProps,
  {
    /** ARM resource ID of the tag description. */
    tagDescriptionId: string;
    /** Identifier of the API. */
    apiName: string;
    /** Identifier of the described tag. */
    tagName: string;
    /** API Management service that holds the API and tag. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * Describes how an API Management {@link Tag} applies to an API
 * (`apis/{apiId}/tagDescriptions/{tagId}`). It maps to an OpenAPI tag
 * object (description and external docs) and attaches the tag to the API.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/api-tag-description
 *
 * ### Documenting a Tag
 * **Example:** Describe the orders tag with external docs
 * ```typescript
 * yield* Azure.ApiManagement.ApiTagDescription("orders-tag-docs", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   tagName: tag.tagName,
 *   description: "Operations on customer orders",
 *   externalDocsUrl: "https://example.com/docs/orders",
 *   externalDocsDescription: "Orders guide",
 * });
 * ```
 *
 * @resource
 */
export const ApiTagDescription = Resource<ApiTagDescription>(
  "Azure.ApiManagement.ApiTagDescription",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  tagName: string;
}

export const ApiTagDescriptionProvider = () =>
  Provider.succeed(ApiTagDescription, {
    stables: [
      "tagDescriptionId",
      "apiName",
      "tagName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      ApiTagDescriptionProps,
      ApiTagDescription["Attributes"],
      Key,
      apim.GetApiTagDescriptionResponse
    >({
      label: (key) =>
        `API Management description of tag ${key.tagName} on API ${key.apiName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          apiName: props.apiName,
          tagName: props.tagName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetApiTagDescription({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          tagDescriptionId: key.tagName,
        }),
      put: (subscriptionId, key, news) =>
        apim.ApiTagDescriptionCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          tagDescriptionId: key.tagName,
          properties: {
            description: news.description,
            externalDocsUrl: news.externalDocsUrl,
            externalDocsDescription: news.externalDocsDescription,
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteApiTagDescription({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          tagDescriptionId: key.tagName,
        }),
      inSync: (news, observed) =>
        (news.description ?? "") === (observed.properties?.description ?? "") &&
        (news.externalDocsUrl ?? "") ===
          (observed.properties?.externalDocsUrl ?? "") &&
        (news.externalDocsDescription ?? "") ===
          (observed.properties?.externalDocsDescription ?? ""),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        tagName: key.tagName,
        tagDescriptionId: observed.id ?? "",
      }),
    }),
  });
