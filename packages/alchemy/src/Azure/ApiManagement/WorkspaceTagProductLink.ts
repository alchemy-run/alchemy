import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface WorkspaceTagProductLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the tag and product. Changing it replaces the link. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /** Identifier of the tag (`Tag.tagName`). Changing it replaces the link. */
  tagName: string;
  /** Identifier of the product to tag. Changing it replaces the link. */
  productName: string;
  /**
   * Link identifier, unique within the tag. Changing it replaces the
   * link.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
}

export interface WorkspaceTagProductLink extends Resource<
  "Azure.ApiManagement.WorkspaceTagProductLink",
  WorkspaceTagProductLinkProps,
  {
    /** Link identifier within the tag. */
    linkName: string;
    /** ARM resource ID of the link. */
    linkId: string;
    /** Identifier of the tag. */
    tagName: string;
    /** Identifier of the product to tag. */
    productName: string;
    /** API Management service that holds the tag and product. */
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
 * The workspace-scoped counterpart of {@link TagProductLink}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * Assigns an API Management {@link Tag} to a product through a named link
 * entity (`tags/{tagId}/productLinks/{linkId}`). It expresses the same
 * relation as {@link ProductTagLink}; use one or the other.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag-product-link
 *
 * ### Tagging Products from the Tag Side
 * **Example:** Tag the starter product as free
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceTagProductLink("free-starter", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   tagName: free.tagName,
 *   productName: starter.productName,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceTagProductLink = Resource<WorkspaceTagProductLink>(
  "Azure.ApiManagement.WorkspaceTagProductLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  tagName: string;
  productName: string;
  linkName: string;
}

export const WorkspaceTagProductLinkProvider = () =>
  Provider.succeed(WorkspaceTagProductLink, {
    stables: [
      "linkName",
      "linkId",
      "tagName",
      "productName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceTagProductLinkProps,
      WorkspaceTagProductLink["Attributes"],
      Key,
      apim.GetWorkspaceTagProductLinkResponse
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
            productName: props.productName,
            linkName:
              props.name ?? output?.linkName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceTagProductLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          productLinkId: key.linkName,
        }),
      put: (subscriptionId, key) =>
        apim.WorkspaceTagProductLinkCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          productLinkId: key.linkName,
          properties: {
            productId: serviceEntityId(
              subscriptionId,
              key,
              `workspaces/${key.workspaceName}/products/${key.productName}`,
            ),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceTagProductLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          tagId: key.tagName,
          productLinkId: key.linkName,
        }),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        tagName: key.tagName,
        productName: key.productName,
        linkName: key.linkName,
        linkId: observed.id ?? "",
      }),
    }),
  });
