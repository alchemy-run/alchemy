import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface WorkspaceTagOperationLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the tag and API operation. Changing it replaces the link. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
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

export interface WorkspaceTagOperationLink extends Resource<
  "Azure.ApiManagement.WorkspaceTagOperationLink",
  WorkspaceTagOperationLinkProps,
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
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link TagOperationLink}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * Assigns an API Management {@link Tag} to an API operation through a
 * named link entity (`tags/{tagId}/operationLinks/{linkId}`). It expresses
 * the same relation as {@link ApiOperationTagLink}; use one or the other.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag-operation-link
 *
 * ### Tagging Operations from the Tag Side
 * **Example:** Mark an operation as deprecated
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceTagOperationLink("deprecated-get-order", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   tagName: deprecated.tagName,
 *   apiName: orders.apiName,
 *   operationName: getOrder.operationName,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceTagOperationLink = Resource<WorkspaceTagOperationLink>(
  "Azure.ApiManagement.WorkspaceTagOperationLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  tagName: string;
  apiName: string;
  operationName: string;
  linkName: string;
}

export const WorkspaceTagOperationLinkProvider = () =>
  Provider.succeed(WorkspaceTagOperationLink, {
    stables: [
      "linkName",
      "linkId",
      "tagName",
      "apiName",
      "operationName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceTagOperationLinkProps,
      WorkspaceTagOperationLink["Attributes"],
      Key,
      apim.GetWorkspaceTagOperationLinkResponse
    >({
      label: (key) =>
        `API Management link ${key.linkName} of tag ${key.tagName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            tagName: props.tagName,
            apiName: props.apiName,
            operationName: props.operationName,
            linkName:
              props.name ?? output?.linkName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceTagOperationLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          operationLinkId: key.linkName,
        }),
      put: (subscriptionId, key) =>
        apim.WorkspaceTagOperationLinkCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          operationLinkId: key.linkName,
          properties: {
            operationId: serviceEntityId(
              subscriptionId,
              key,
              `workspaces/${key.workspaceName}/apis/${key.apiName}/operations/${key.operationName}`,
            ),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceTagOperationLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          operationLinkId: key.linkName,
        }),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        tagName: key.tagName,
        apiName: key.apiName,
        operationName: key.operationName,
        linkName: key.linkName,
        linkId: observed.id ?? "",
      }),
    }),
  });
