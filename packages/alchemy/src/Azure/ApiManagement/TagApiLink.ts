import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface TagApiLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the tag and API. Changing it replaces the link. */
  serviceName: string;
  /** Identifier of the tag (`Tag.tagName`). Changing it replaces the link. */
  tagName: string;
  /** Identifier of the API to tag. Changing it replaces the link. */
  apiName: string;
  /**
   * Link identifier, unique within the tag. Changing it replaces the
   * link.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
}

export interface TagApiLink extends Resource<
  "Azure.ApiManagement.TagApiLink",
  TagApiLinkProps,
  {
    /** Link identifier within the tag. */
    linkName: string;
    /** ARM resource ID of the link. */
    linkId: string;
    /** Identifier of the tag. */
    tagName: string;
    /** Identifier of the API to tag. */
    apiName: string;
    /** API Management service that holds the tag and API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * Assigns an API Management {@link Tag} to an API through a named link
 * entity (`tags/{tagId}/apiLinks/{linkId}`). It expresses the same
 * relation as {@link ApiTagLink}; use one or the other.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag-api-link
 *
 * ### Tagging APIs from the Tag Side
 * **Example:** Tag the orders API as public
 * ```typescript
 * yield* Azure.ApiManagement.TagApiLink("public-orders", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   tagName: publicTag.tagName,
 *   apiName: orders.apiName,
 * });
 * ```
 *
 * @resource
 */
export const TagApiLink = Resource<TagApiLink>(
  "Azure.ApiManagement.TagApiLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  tagName: string;
  apiName: string;
  linkName: string;
}

export const TagApiLinkProvider = () =>
  Provider.succeed(TagApiLink, {
    stables: [
      "linkName",
      "linkId",
      "tagName",
      "apiName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      TagApiLinkProps,
      TagApiLink["Attributes"],
      Key,
      apim.GetTagApiLinkResponse
    >({
      label: (key) =>
        `API Management link ${key.linkName} of tag ${key.tagName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            tagName: props.tagName,
            apiName: props.apiName,
            linkName:
              props.name ?? output?.linkName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetTagApiLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          tagId: key.tagName,
          apiLinkId: key.linkName,
        }),
      put: (subscriptionId, key) =>
        apim.TagApiLinkCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          tagId: key.tagName,
          apiLinkId: key.linkName,
          properties: {
            apiId: serviceEntityId(subscriptionId, key, `apis/${key.apiName}`),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteTagApiLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          tagId: key.tagName,
          apiLinkId: key.linkName,
        }),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        tagName: key.tagName,
        apiName: key.apiName,
        linkName: key.linkName,
        linkId: observed.id ?? "",
      }),
    }),
  });
