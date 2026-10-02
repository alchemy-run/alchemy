import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface ProductTagLinkProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the product and tag. Changing it replaces the link. */
  serviceName: string;
  /** Identifier of the product to tag. Changing it replaces the link. */
  productName: string;
  /** Identifier of the tag (`Tag.tagName`). Changing it replaces the link. */
  tagName: string;
}

export interface ProductTagLink extends Resource<
  "Azure.ApiManagement.ProductTagLink",
  ProductTagLinkProps,
  {
    /** ARM resource ID of the product's tag assignment. */
    linkId: string;
    /** Identifier of the tagged product. */
    productName: string;
    /** Identifier of the tag. */
    tagName: string;
    /** API Management service that holds the product and tag. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * Assigns an API Management {@link Tag} to a product
 * (`products/{productId}/tags/{tagId}`), so the developer portal can
 * filter products by tag. The assignment has no settings; changing the
 * product or tag replaces it. {@link TagProductLink} expresses the same
 * relation from the tag side; use one or the other.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/tag/assign-to-product
 *
 * ### Tagging a Product
 * **Example:** Tag a product as free
 * ```typescript
 * yield* Azure.ApiManagement.ProductTagLink("starter-free", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   productName: product.productName,
 *   tagName: free.tagName,
 * });
 * ```
 *
 * @resource
 */
export const ProductTagLink = Resource<ProductTagLink>(
  "Azure.ApiManagement.ProductTagLink",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  productName: string;
  tagName: string;
}

export const ProductTagLinkProvider = () =>
  Provider.succeed(ProductTagLink, {
    stables: [
      "linkId",
      "productName",
      "tagName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      ProductTagLinkProps,
      ProductTagLink["Attributes"],
      Key,
      apim.GetTagByProductResponse
    >({
      label: (key) =>
        `API Management tag ${key.tagName} on product ${key.productName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          productName: props.productName,
          tagName: props.tagName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetTagByProduct({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          productId: key.productName,
          tagId: key.tagName,
        }),
      put: (subscriptionId, key) =>
        apim.AssignTagToProduct({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          productId: key.productName,
          tagId: key.tagName,
        }),
      remove: (subscriptionId, key) =>
        apim.DetachTagFromProduct({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          productId: key.productName,
          tagId: key.tagName,
        }),
      toAttrs: (subscriptionId, key) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        productName: key.productName,
        tagName: key.tagName,
        linkId: serviceEntityId(
          subscriptionId,
          key,
          `products/${key.productName}/tags/${key.tagName}`,
        ),
      }),
    }),
  });
