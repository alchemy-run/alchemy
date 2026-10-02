import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface ApiOperationTagLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the API and tag. Changing it replaces the link. */
  serviceName: string;
  /** Identifier of the API that holds the operation. Changing it replaces the link. */
  apiName: string;
  /** Identifier of the operation to tag. Changing it replaces the link. */
  operationName: string;
  /** Identifier of the tag (`Tag.tagName`). Changing it replaces the link. */
  tagName: string;
}

export interface ApiOperationTagLink extends Resource<
  "Azure.ApiManagement.ApiOperationTagLink",
  ApiOperationTagLinkProps,
  {
    /** ARM resource ID of the operation's tag assignment. */
    linkId: string;
    /** Identifier of the API that holds the operation. */
    apiName: string;
    /** Identifier of the tagged operation. */
    operationName: string;
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
 * Assigns an API Management {@link Tag} to a single API operation
 * (`apis/{apiId}/operations/{operationId}/tags/{tagId}`). The assignment
 * has no settings; changing the operation or tag replaces it.
 * {@link TagOperationLink} expresses the same relation from the tag side.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag/assign-to-operation
 *
 * ### Tagging an Operation
 * **Example:** Mark one operation as deprecated
 * ```typescript
 * yield* Azure.ApiManagement.ApiOperationTagLink("get-order-deprecated", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   operationName: getOrder.operationName,
 *   tagName: deprecated.tagName,
 * });
 * ```
 *
 * @resource
 */
export const ApiOperationTagLink = Resource<ApiOperationTagLink>(
  "Azure.ApiManagement.ApiOperationTagLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  operationName: string;
  tagName: string;
}

export const ApiOperationTagLinkProvider = () =>
  Provider.succeed(ApiOperationTagLink, {
    stables: [
      "linkId",
      "apiName",
      "operationName",
      "tagName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      ApiOperationTagLinkProps,
      ApiOperationTagLink["Attributes"],
      Key,
      apim.GetTagByOperationResponse
    >({
      label: (key) =>
        `API Management tag ${key.tagName} on operation ${key.operationName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          apiName: props.apiName,
          operationName: props.operationName,
          tagName: props.tagName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetTagByOperation({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          operationId: key.operationName,
          tagId: key.tagName,
        }),
      put: (subscriptionId, key) =>
        apim.AssignTagToOperation({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          operationId: key.operationName,
          tagId: key.tagName,
        }),
      remove: (subscriptionId, key) =>
        apim.DetachTagFromOperation({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          operationId: key.operationName,
          tagId: key.tagName,
        }),
      toAttrs: (subscriptionId, key) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        operationName: key.operationName,
        tagName: key.tagName,
        linkId: serviceEntityId(
          subscriptionId,
          key,
          `apis/${key.apiName}/operations/${key.operationName}/tags/${key.tagName}`,
        ),
      }),
    }),
  });
