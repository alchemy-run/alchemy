import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle } from "./Entity.ts";

export interface ProductWikiProps {
  /** Resource group of the API Management service. Changing it replaces the wiki. */
  resourceGroup: string;
  /** API Management service that holds the product. Changing it replaces the wiki. */
  serviceName: string;
  /** Identifier of the product. Changing it replaces the wiki. */
  productName: string;
  /**
   * Identifiers of the {@link Documentation} pages shown in the API's wiki,
   * in order.
   * @default []
   */
  documents?: string[];
}

export interface ProductWiki extends Resource<
  "Azure.ApiManagement.ProductWiki",
  ProductWikiProps,
  {
    /** ARM resource ID of the wiki. */
    wikiId: string;
    /** Identifier of the product. */
    productName: string;
    /** API Management service that holds the product. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Identifiers of the documentation pages in the wiki. */
    documents: string[];
  },
  never,
  Providers
> {}

/**
 * The wiki of a product in API Management: an ordered list of
 * {@link Documentation} pages shown with the product in the developer
 * portal. There is one per product.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/product-wiki
 *
 * ### Attaching Documentation
 * **Example:** Show onboarding docs with a product
 * ```typescript
 * yield* Azure.ApiManagement.ProductWiki("starter-wiki", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   productName: product.productName,
 *   documents: [onboarding.documentationName],
 * });
 * ```
 *
 * @resource
 */
export const ProductWiki = Resource<ProductWiki>(
  "Azure.ApiManagement.ProductWiki",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  productName: string;
}

const documentIds = (wiki: apim.GetProductWikiResponse) =>
  (wiki.properties?.documents ?? []).flatMap((doc) =>
    doc.documentationId === undefined ? [] : [doc.documentationId],
  );

export const ProductWikiProvider = () =>
  Provider.succeed(ProductWiki, {
    stables: ["wikiId", "productName", "serviceName", "resourceGroup"],
    ...entityLifecycle<
      ProductWikiProps,
      ProductWiki["Attributes"],
      Key,
      apim.GetProductWikiResponse
    >({
      label: (key) => `API Management wiki of product ${key.productName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          productName: props.productName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetProductWiki({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          productId: key.productName,
        }),
      put: (subscriptionId, key, news) =>
        apim.ProductWikiCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          productId: key.productName,
          properties: {
            documents: (news.documents ?? []).map((documentationId) => ({
              documentationId,
            })),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteProductWiki({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          productId: key.productName,
        }),
      inSync: (news, observed) =>
        documentIds(observed).join("\n") === (news.documents ?? []).join("\n"),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        productName: key.productName,
        wikiId: observed.id ?? "",
        documents: documentIds(observed),
      }),
    }),
  });
