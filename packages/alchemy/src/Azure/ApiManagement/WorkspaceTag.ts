import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceTagProps {
  /** Resource group of the API Management service. Changing it replaces the tag. */
  resourceGroup: string;
  /** API Management service that holds the tag. Changing it replaces the tag. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /**
   * WorkspaceTag identifier, unique within the service. Changing it replaces the tag.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /**
   * Display name shown in the developer portal and used to search APIs.
   * @default the tag identifier
   */
  displayName?: string;
}

export interface WorkspaceTag extends Resource<
  "Azure.ApiManagement.WorkspaceTag",
  WorkspaceTagProps,
  {
    /** WorkspaceTag identifier within the service. */
    tagName: string;
    /** ARM resource ID of the tag. */
    tagId: string;
    /** API Management service that holds the tag. */
    serviceName: string;
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name of the tag. */
    displayName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Tag}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * An API Management tag entity, used to group and search APIs, operations,
 * and products (via {@link TagApiLink}, {@link TagOperationLink},
 * {@link TagProductLink}, {@link ApiTagLink}, ...). These are not ARM
 * resource tags.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag
 *
 * ### Creating Tags
 * **Example:** Tag an API as public
 * ```typescript
 * const tag = yield* Azure.ApiManagement.WorkspaceTag("public", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   displayName: "Public",
 * });
 * yield* Azure.ApiManagement.WorkspaceTagApiLink("orders-public", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   tagName: tag.tagName,
 *   apiName: api.apiName,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceTag = Resource<WorkspaceTag>(
  "Azure.ApiManagement.WorkspaceTag",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  tagName: string;
}

export const WorkspaceTagProvider = () =>
  Provider.succeed(WorkspaceTag, {
    stables: [
      "tagName",
      "tagId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceTagProps,
      WorkspaceTag["Attributes"],
      Key,
      apim.GetWorkspaceTagResponse
    >({
      label: (key) => `API Management tag ${key.tagName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            tagName:
              props.name ?? output?.tagName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceTag({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceTagCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          properties: { displayName: news.displayName ?? key.tagName },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceTag({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
        }),
      inSync: (news, observed) =>
        observed.properties?.displayName ===
        (news.displayName ?? observed.name),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        tagName: key.tagName,
        tagId: observed.id ?? "",
        displayName: observed.properties?.displayName ?? key.tagName,
      }),
    }),
  });
