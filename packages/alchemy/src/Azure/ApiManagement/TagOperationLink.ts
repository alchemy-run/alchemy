import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface TagOperationLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the tag and API operation. Changing it replaces the link. */
  serviceName: string;
  /** Identifier of the tag (`Tag.tagName`). Changing it replaces the link. */
  tagName: string;
  /** Identifier of the API that holds the operation. Changing it replaces the link. */
  apiName: string;
  /** Identifier of the operation to tag. Changing it replaces the link. */
  operationName: string;
  /**
   * Link identifier, unique within the tag. Changing it replaces the
   * link.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
}

export interface TagOperationLink extends Resource<
  "Azure.ApiManagement.TagOperationLink",
  TagOperationLinkProps,
  {
    /** Link identifier within the tag. */
    linkName: string;
    /** ARM resource ID of the link. */
    linkId: string;
    /** Identifier of the tag. */
    tagName: string;
    /** Identifier of the API that holds the operation. */
    apiName: string;
    /** Identifier of the operation to tag. */
    operationName: string;
    /** API Management service that holds the tag and API operation. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * Assigns an API Management {@link Tag} to an API operation through a
 * named link entity (`tags/{tagId}/operationLinks/{linkId}`). It expresses
 * the same relation as {@link ApiOperationTagLink}; use one or the other.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag-operation-link
 *
 * ### Tagging Operations from the Tag Side
 * **Example:** Mark an operation as deprecated
 * ```typescript
 * yield* Azure.ApiManagement.TagOperationLink("deprecated-get-order", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   tagName: deprecated.tagName,
 *   apiName: orders.apiName,
 *   operationName: getOrder.operationName,
 * });
 * ```
 *
 * @resource
 */
export const TagOperationLink = Resource<TagOperationLink>(
  "Azure.ApiManagement.TagOperationLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  tagName: string;
  apiName: string;
  operationName: string;
  linkName: string;
}

export const TagOperationLinkProvider = () =>
  Provider.succeed(TagOperationLink, {
    stables: [
      "linkName",
      "linkId",
      "tagName",
      "apiName",
      "operationName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      TagOperationLinkProps,
      TagOperationLink["Attributes"],
      Key,
      apim.GetTagOperationLinkResponse
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
            operationName: props.operationName,
            linkName:
              props.name ?? output?.linkName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetTagOperationLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          tagId: key.tagName,
          operationLinkId: key.linkName,
        }),
      put: (subscriptionId, key) =>
        apim.TagOperationLinkCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          tagId: key.tagName,
          operationLinkId: key.linkName,
          properties: {
            operationId: serviceEntityId(
              subscriptionId,
              key,
              `apis/${key.apiName}/operations/${key.operationName}`,
            ),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteTagOperationLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          tagId: key.tagName,
          operationLinkId: key.linkName,
        }),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        tagName: key.tagName,
        apiName: key.apiName,
        operationName: key.operationName,
        linkName: key.linkName,
        linkId: observed.id ?? "",
      }),
    }),
  });
