import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isParentOwned, sameName } from "./Common.ts";

export interface ProductApiProps {
  /** Resource group of the API Management service. Changing it replaces the link. */
  resourceGroup: string;
  /** API Management service that holds the product and API. Changing it replaces the link. */
  serviceName: string;
  /** Identifier of the product. Changing it replaces the link. */
  productName: string;
  /** Identifier of the API added to the product. Changing it replaces the link. */
  apiName: string;
}

export interface ProductApi extends Resource<
  "Azure.ApiManagement.ProductApi",
  ProductApiProps,
  {
    /** ARM resource ID of the product/API association. */
    productApiId: string;
    /** Identifier of the product. */
    productName: string;
    /** Identifier of the API. */
    apiName: string;
    /** API Management service that holds the product and API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * Adds an API to an API Management product, so subscriptions to the
 * product can call the API. The association has no settings; changing
 * the product or API replaces it.
 *
 * `products/{productId}/apiLinks` expresses the same relation; use one or
 * the other for a given product and API, not both.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-add-products
 *
 * ### Adding an API to a Product
 * **Example:** Publish an API through a product
 * ```typescript
 * yield* Azure.ApiManagement.ProductApi("starter-hello", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   productName: product.productName,
 *   apiName: api.apiName,
 * });
 * ```
 *
 * @resource
 */
export const ProductApi = Resource<ProductApi>(
  "Azure.ApiManagement.ProductApi",
);

/**
 * Find the API among the product's APIs. There is no GET for a single
 * association, so the product's API list is filtered by name.
 */
const findProductApi = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  productId: string,
  apiId: string,
) =>
  orUndefinedIfNotFound(
    apim
      .ListProductApiByProduct({
        subscriptionId,
        resourceGroupName,
        serviceName,
        productId,
        _filter: `name eq '${apiId}'`,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListProductApiByProduct", page),
        ),
        Effect.map((page) =>
          page.value?.find((api) => sameName(api.name, apiId)),
        ),
      ),
  );

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  serviceName: string,
  productName: string,
  apiName: string,
): ProductApi["Attributes"] => ({
  productApiId: `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.ApiManagement/service/${serviceName}/products/${productName}/apis/${apiName}`,
  productName,
  apiName,
  serviceName,
  resourceGroup,
});

export const ProductApiProvider = () =>
  Provider.succeed(ProductApi, {
    stables: [
      "productApiId",
      "productName",
      "apiName",
      "serviceName",
      "resourceGroup",
    ],

    // Associations live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        !sameName(news.productName, output.productName) ||
        !sameName(news.apiName, output.apiName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      const productName = output?.productName ?? olds?.productName;
      const apiName = output?.apiName ?? olds?.apiName;
      if (
        resourceGroup === undefined ||
        serviceName === undefined ||
        productName === undefined ||
        apiName === undefined
      ) {
        return undefined;
      }
      const observed = yield* findProductApi(
        subscriptionId,
        resourceGroup,
        serviceName,
        productName,
        apiName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        subscriptionId,
        resourceGroup,
        serviceName,
        productName,
        apiName,
      );
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName, productName, apiName } = news;

      // Existence-only: observe, then create when missing.
      const observed = yield* findProductApi(
        subscriptionId,
        resourceGroup,
        serviceName,
        productName,
        apiName,
      );
      if (observed === undefined) {
        yield* apim.ProductApiCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serviceName,
          productId: productName,
          apiId: apiName,
        });
      }
      return toAttrs(
        subscriptionId,
        resourceGroup,
        serviceName,
        productName,
        apiName,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteProductApi({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          productId: output.productName,
          apiId: output.apiName,
        }),
      );
      yield* waitUntilGone(
        `API ${output.apiName} in product ${output.productName}`,
        findProductApi(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.productName,
          output.apiName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
