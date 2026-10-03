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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createEntityName,
  isParentOwned,
  sameName,
  subsetMatches,
} from "./Common.ts";

export type ProductState = "notPublished" | "published";

export interface ProductProps {
  /** Resource group of the API Management service. Changing it replaces the product. */
  resourceGroup: string;
  /** API Management service that holds the product. Changing it replaces the product. */
  serviceName: string;
  /**
   * Product identifier (1-256 characters). If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces
   * the product.
   */
  name?: string;
  /**
   * Display name shown in the developer portal.
   * @default the product identifier
   */
  displayName?: string;
  /** Description; may contain HTML. */
  description?: string;
  /** Terms of use developers must accept before subscribing. */
  terms?: string;
  /**
   * Whether a subscription key is required to call the product's APIs.
   * @default true
   */
  subscriptionRequired?: boolean;
  /**
   * Whether subscription requests need administrator approval. Only valid
   * when `subscriptionRequired` is `true`.
   */
  approvalRequired?: boolean;
  /**
   * Maximum number of subscriptions per user. Only valid when
   * `subscriptionRequired` is `true`.
   */
  subscriptionsLimit?: number;
  /**
   * Whether the product is visible to developers.
   * @default "notPublished"
   */
  state?: ProductState;
}

export interface Product extends Resource<
  "Azure.ApiManagement.Product",
  ProductProps,
  {
    /** Product identifier. */
    productName: string;
    /** ARM resource ID of the product; use it as a subscription scope. */
    productId: string;
    /** API Management service that holds the product. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Display name. */
    displayName: string;
    /** Publication state. */
    state: string;
    /** Whether a subscription key is required. */
    subscriptionRequired: boolean;
  },
  never,
  Providers
> {}

/**
 * An API Management product — a bundle of APIs that developers subscribe
 * to. Deleting the product also deletes its subscriptions.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-add-products
 *
 * ### Creating a Product
 * **Example:** Published product that requires a subscription
 * ```typescript
 * const product = yield* Azure.ApiManagement.Product("starter", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   displayName: "Starter",
 *   subscriptionRequired: true,
 *   state: "published",
 * });
 * ```
 *
 * **Example:** Open product (no subscription key)
 * ```typescript
 * const open = yield* Azure.ApiManagement.Product("open", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   subscriptionRequired: false,
 *   state: "published",
 * });
 * ```
 *
 * @resource
 */
export const Product = Resource<Product>("Azure.ApiManagement.Product");

const getProduct = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  productId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetProduct({
      subscriptionId,
      resourceGroupName,
      serviceName,
      productId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  name: string,
  product: apim.GetProductResponse,
): Product["Attributes"] => ({
  productName: name,
  productId: product.id ?? "",
  serviceName,
  resourceGroup,
  displayName: product.properties?.displayName ?? name,
  state: product.properties?.state ?? "notPublished",
  subscriptionRequired: product.properties?.subscriptionRequired ?? true,
});

export const ProductProvider = () =>
  Provider.succeed(Product, {
    stables: ["productName", "productId", "serviceName", "resourceGroup"],

    // Products live inside a service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        (news.name !== undefined && !sameName(news.name, output.productName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const name =
        output?.productName ?? olds?.name ?? (yield* createEntityName(id));
      const observed = yield* getProduct(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const name =
        news.name ?? output?.productName ?? (yield* createEntityName(id));
      const desired: apim.ProductContractProperties = {
        displayName: news.displayName ?? name,
        description: news.description,
        terms: news.terms,
        subscriptionRequired: news.subscriptionRequired ?? true,
        approvalRequired: news.approvalRequired,
        subscriptionsLimit: news.subscriptionsLimit,
        state: news.state ?? "notPublished",
      };

      // Observe, then create or sync with one upsert when anything differs.
      const observed = yield* getProduct(
        subscriptionId,
        resourceGroup,
        serviceName,
        name,
      );
      const current =
        observed !== undefined && subsetMatches(desired, observed.properties)
          ? observed
          : yield* apim.ProductCreateOrUpdate({
              subscriptionId,
              resourceGroupName: resourceGroup,
              serviceName,
              productId: name,
              properties: desired,
            });
      return toAttrs(resourceGroup, serviceName, name, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        apim.DeleteProduct({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          productId: output.productName,
          deleteSubscriptions: true,
        }),
      );
      yield* waitUntilGone(
        `API Management product ${output.productName}`,
        getProduct(
          subscriptionId,
          output.resourceGroup,
          output.serviceName,
          output.productName,
        ),
        { interval: "2 seconds", times: 15 },
      );
    }),
  });
