import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Product, ProductProps } from "./Product.ts";
import { createEntityName, subsetMatches } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface WorkspaceProductProps extends ProductProps {
  /** Workspace that holds the product (`Workspace.workspaceName`). Changing it replaces the product. */
  workspaceName: string;
}

export interface WorkspaceProduct extends Resource<
  "Azure.ApiManagement.WorkspaceProduct",
  WorkspaceProductProps,
  Product["Attributes"] & {
    /** Workspace that holds the product. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Product}: a product inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link Product} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Products
 * **Example:** A published product
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceProduct("starter", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   displayName: "Starter",
 *   state: "published",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceProduct = Resource<WorkspaceProduct>(
  "Azure.ApiManagement.WorkspaceProduct",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  productName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  productId: key.productName,
});

const desiredOf = (
  news: WorkspaceProductProps,
  name: string,
): apim.ProductContractProperties => ({
  displayName: news.displayName ?? name,
  description: news.description,
  terms: news.terms,
  subscriptionRequired: news.subscriptionRequired ?? true,
  approvalRequired: news.approvalRequired,
  subscriptionsLimit: news.subscriptionsLimit,
  state: news.state ?? "notPublished",
});

export const WorkspaceProductProvider = () =>
  Provider.succeed(WorkspaceProduct, {
    stables: [
      "productName",
      "productId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceProductProps,
      WorkspaceProduct["Attributes"],
      Key,
      apim.GetWorkspaceProductResponse
    >({
      label: (key) => `API Management workspace product ${key.productName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            productName:
              props.name ??
              output?.productName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceProduct({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceProductCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: desiredOf(news, key.productName),
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceProduct({
          ...where(subscriptionId, key),
        }),
      inSync: (news, observed) =>
        subsetMatches(
          desiredOf(news, observed.name ?? ""),
          observed.properties,
        ),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        productName: key.productName,
        productId: observed.id ?? "",
        displayName: observed.properties?.displayName ?? key.productName,
        state: observed.properties?.state ?? "notPublished",
        subscriptionRequired: observed.properties?.subscriptionRequired ?? true,
      }),
    }),
  });
