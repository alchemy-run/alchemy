import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface WorkspaceProductGroupLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the product and group. Changing it replaces the link. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /** Identifier of the product (`Product.productName`). Changing it replaces the link. */
  productName: string;
  /** Identifier of the group (`Group.groupName`) given access to the product. Changing it replaces the link. */
  groupName: string;
  /**
   * Link identifier, unique within the product. Changing it replaces the
   * link.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
}

export interface WorkspaceProductGroupLink extends Resource<
  "Azure.ApiManagement.WorkspaceProductGroupLink",
  WorkspaceProductGroupLinkProps,
  {
    /** Link identifier within the product. */
    linkName: string;
    /** ARM resource ID of the link. */
    linkId: string;
    /** Identifier of the product. */
    productName: string;
    /** Identifier of the group (`Group.groupName`) given access to the product. */
    groupName: string;
    /** API Management service that holds the product and group. */
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
 * The workspace-scoped counterpart of {@link ProductGroupLink}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * Makes an API Management product visible to a {@link Group} through a
 * named link entity (`products/{productId}/groupLinks/{linkId}`). It
 * expresses the same relation as {@link ProductGroup}; use one or the
 * other. Groups are not available on the Consumption tier.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/product-group-link
 *
 * ### Granting Product Access
 * **Example:** Let partners see the premium product
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceProductGroupLink("premium-partners", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   productName: premium.productName,
 *   groupName: partners.groupName,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceProductGroupLink = Resource<WorkspaceProductGroupLink>(
  "Azure.ApiManagement.WorkspaceProductGroupLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  productName: string;
  groupName: string;
  linkName: string;
}

export const WorkspaceProductGroupLinkProvider = () =>
  Provider.succeed(WorkspaceProductGroupLink, {
    stables: [
      "linkName",
      "linkId",
      "productName",
      "groupName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceProductGroupLinkProps,
      WorkspaceProductGroupLink["Attributes"],
      Key,
      apim.GetWorkspaceProductGroupLinkResponse
    >({
      label: (key) =>
        `API Management link ${key.linkName} of product ${key.productName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            productName: props.productName,
            groupName: props.groupName,
            linkName:
              props.name ?? output?.linkName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceProductGroupLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          productId: key.productName,
          groupLinkId: key.linkName,
        }),
      put: (subscriptionId, key) =>
        apim.WorkspaceProductGroupLinkCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          productId: key.productName,
          groupLinkId: key.linkName,
          properties: {
            groupId: serviceEntityId(
              subscriptionId,
              key,
              `workspaces/${key.workspaceName}/groups/${key.groupName}`,
            ),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceProductGroupLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          productId: key.productName,
          groupLinkId: key.linkName,
        }),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        productName: key.productName,
        groupName: key.groupName,
        linkName: key.linkName,
        linkId: observed.id ?? "",
      }),
    }),
  });
