import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface WorkspaceTagApiLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the tag and API. Changing it replaces the link. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
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

export interface WorkspaceTagApiLink extends Resource<
  "Azure.ApiManagement.WorkspaceTagApiLink",
  WorkspaceTagApiLinkProps,
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
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link TagApiLink}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * Assigns an API Management {@link Tag} to an API through a named link
 * entity (`tags/{tagId}/apiLinks/{linkId}`). It expresses the same
 * relation as {@link ApiTagLink}; use one or the other.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag-api-link
 *
 * ### Tagging APIs from the Tag Side
 * **Example:** Tag the orders API as public
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceTagApiLink("public-orders", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   tagName: publicTag.tagName,
 *   apiName: orders.apiName,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceTagApiLink = Resource<WorkspaceTagApiLink>(
  "Azure.ApiManagement.WorkspaceTagApiLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  tagName: string;
  apiName: string;
  linkName: string;
}

export const WorkspaceTagApiLinkProvider = () =>
  Provider.succeed(WorkspaceTagApiLink, {
    stables: [
      "linkName",
      "linkId",
      "tagName",
      "apiName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceTagApiLinkProps,
      WorkspaceTagApiLink["Attributes"],
      Key,
      apim.GetWorkspaceTagApiLinkResponse
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
            linkName:
              props.name ?? output?.linkName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceTagApiLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          apiLinkId: key.linkName,
        }),
      put: (subscriptionId, key) =>
        apim.WorkspaceTagApiLinkCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          apiLinkId: key.linkName,
          properties: {
            apiId: serviceEntityId(
              subscriptionId,
              key,
              `workspaces/${key.workspaceName}/apis/${key.apiName}`,
            ),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceTagApiLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          apiLinkId: key.linkName,
        }),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        tagName: key.tagName,
        apiName: key.apiName,
        linkName: key.linkName,
        linkId: observed.id ?? "",
      }),
    }),
  });
