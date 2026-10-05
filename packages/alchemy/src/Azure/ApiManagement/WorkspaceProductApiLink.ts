import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface WorkspaceProductApiLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the product and API. Changing it replaces the link. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /** Identifier of the product. Changing it replaces the link. */
  productName: string;
  /** Identifier of the API added to the product. Changing it replaces the link. */
  apiName: string;
  /**
   * Link identifier, unique within the product. Changing it replaces the
   * link.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
}

export interface WorkspaceProductApiLink extends Resource<
  "Azure.ApiManagement.WorkspaceProductApiLink",
  WorkspaceProductApiLinkProps,
  {
    /** Link identifier within the product. */
    linkName: string;
    /** ARM resource ID of the link. */
    linkId: string;
    /** Identifier of the product. */
    productName: string;
    /** Identifier of the linked API. */
    apiName: string;
    /** API Management service that holds the product and API. */
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
 * The workspace-scoped counterpart of {@link ProductApiLink}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * Adds an API to an API Management product as a named link entity
 * (`products/{productId}/apiLinks/{linkId}`). It expresses the same
 * relation as {@link ProductApi}; use one or the other for a given
 * product and API.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/product-api-link
 *
 * ### Linking APIs to Products
 * **Example:** Publish an API through a product
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceProductApiLink("starter-orders", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   productName: product.productName,
 *   apiName: api.apiName,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceProductApiLink = Resource<WorkspaceProductApiLink>(
  "Azure.ApiManagement.WorkspaceProductApiLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  productName: string;
  apiName: string;
  linkName: string;
}

export const WorkspaceProductApiLinkProvider = () =>
  Provider.succeed(WorkspaceProductApiLink, {
    stables: [
      "linkName",
      "linkId",
      "productName",
      "apiName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceProductApiLinkProps,
      WorkspaceProductApiLink["Attributes"],
      Key,
      apim.GetWorkspaceProductApiLinkResponse
    >({
      label: (key) =>
        `API Management link of API ${key.apiName} in product ${key.productName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            productName: props.productName,
            apiName: props.apiName,
            linkName:
              props.name ?? output?.linkName ?? (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceProductApiLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          productId: key.productName,
          apiLinkId: key.linkName,
        }),
      put: (subscriptionId, key) =>
        apim.WorkspaceProductApiLinkCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          productId: key.productName,
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
        apim.DeleteWorkspaceProductApiLink({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          productId: key.productName,
          apiLinkId: key.linkName,
        }),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        productName: key.productName,
        apiName: key.apiName,
        linkName: key.linkName,
        linkId: observed.id ?? "",
      }),
    }),
  });
