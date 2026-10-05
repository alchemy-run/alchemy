import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface ApiTagLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the API and tag. Changing it replaces the link. */
  serviceName: string;
  /** Identifier of the API to tag. Changing it replaces the link. */
  apiName: string;
  /** Identifier of the tag (`Tag.tagName`). Changing it replaces the link. */
  tagName: string;
}

export interface ApiTagLink extends Resource<
  "Azure.ApiManagement.ApiTagLink",
  ApiTagLinkProps,
  {
    /** ARM resource ID of the API's tag assignment. */
    linkId: string;
    /** Identifier of the tagged API. */
    apiName: string;
    /** Identifier of the tag. */
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
 * Assigns an API Management {@link Tag} to an API
 * (`apis/{apiId}/tags/{tagId}`). The assignment has no settings; changing
 * the API or tag replaces it. {@link TagApiLink} expresses the same
 * relation from the tag side; use one or the other.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag/assign-to-api
 *
 * ### Tagging an API
 * **Example:** Tag an API as public
 * ```typescript
 * yield* Azure.ApiManagement.ApiTagLink("orders-public", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   tagName: tag.tagName,
 * });
 * ```
 *
 * @resource
 */
export const ApiTagLink = Resource<ApiTagLink>(
  "Azure.ApiManagement.ApiTagLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  tagName: string;
}

export const ApiTagLinkProvider = () =>
  Provider.succeed(ApiTagLink, {
    stables: ["linkId", "apiName", "tagName", "serviceName", "resourceGroup"],
    ...entityLifecycle<
      ApiTagLinkProps,
      ApiTagLink["Attributes"],
      Key,
      apim.GetTagByApiResponse
    >({
      label: (key) => `API Management tag ${key.tagName} on API ${key.apiName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          apiName: props.apiName,
          tagName: props.tagName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetTagByApi({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          tagId: key.tagName,
        }),
      put: (subscriptionId, key) =>
        apim.AssignTagToApi({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          tagId: key.tagName,
        }),
      remove: (subscriptionId, key) =>
        apim.DetachTagFromApi({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          tagId: key.tagName,
        }),
      toAttrs: (subscriptionId, key) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        tagName: key.tagName,
        linkId: serviceEntityId(
          subscriptionId,
          key,
          `apis/${key.apiName}/tags/${key.tagName}`,
        ),
      }),
    }),
  });
