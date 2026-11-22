import * as sphere from "@distilled.cloud/azure/sphere";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import {
  createAlphanumericName,
  descriptionWithMarker,
  hasMarker,
  ownershipMarker,
  sameName,
  stripMarker,
} from "./internal.ts";

export interface ProductProps {
  /**
   * Resource group of the catalog.
   *
   * :::caution
   * Changing it replaces the product.
   * :::
   */
  resourceGroup: string;
  /**
   * Catalog that holds the product.
   *
   * :::caution
   * Changing it replaces the product.
   * :::
   */
  catalog: string;
  /**
   * Product name: 3-50 letters, digits, and spaces. If omitted, a
   * unique alphanumeric name is generated from the app, stage, and logical ID.
   *
   * :::caution
   * Changing it replaces the product.
   * :::
   * @default an alphanumeric name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Description of the product, at most 77 characters: Azure Sphere stores
   * at most 100, and Alchemy appends a 23-character ownership marker.
   * @default no description
   */
  description?: string;
}

export interface Product extends Resource<
  "Azure.AzureSphere.Product",
  ProductProps,
  {
    /** Name of the product. */
    productName: string;
    /** ARM resource ID of the product. */
    productId: string;
    /** Catalog that holds the product. */
    catalogName: string;
    /** Resource group of the catalog. */
    resourceGroup: string;
    /** Description (Alchemy ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Sphere product (`Microsoft.AzureSphere/catalogs/products`) — a
 * device model (e.g. a dishwasher or a sensor) in a catalog. A product
 * groups the device groups that receive its application and OS updates.
 *
 * Products have no tags, so Alchemy records ownership as a
 * `[alchemy <hash>]` marker (a hash of the stack, stage, and logical ID)
 * at the end of `description`.
 *
 * :::caution
 * Changing `catalog`, `name`, or `resourceGroup` replaces the product.
 * :::
 *
 * @see https://learn.microsoft.com/azure-sphere/deployment/deployment-concepts
 *
 * ### Creating a Product
 * **Example:** Product in a catalog
 * ```typescript
 * const catalog = yield* Azure.AzureSphere.Catalog("fleet");
 * const product = yield* Azure.AzureSphere.Product("dishwasher", {
 *   catalog: catalog.catalogName,
 *   description: "Contoso dishwasher, model 100",
 * });
 * ```
 *
 * @resource
 */
export const Product = GroupedResource<Product>("Azure.AzureSphere.Product");

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  catalogName: string;
  productName: string;
}

const getProduct = (where: Where) => orUndefinedIfNotFound(sphere.GetProduct(where));

const toAttrs = (where: Where, observed: sphere.GetProductResponse): Product["Attributes"] => ({
  productName: where.productName,
  productId: observed.id ?? "",
  catalogName: where.catalogName,
  resourceGroup: where.resourceGroupName,
  description: stripMarker(observed.properties?.description),
});

export const ProductProvider = () =>
  Provider.succeed(Product, {
    stables: ["productName", "productId", "catalogName", "resourceGroup"],

    // Products live inside a catalog; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.catalog, output.catalogName) ||
        (news.name !== undefined && !sameName(news.name, output.productName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const catalogName = output?.catalogName ?? olds?.catalog;
      if (resourceGroupName === undefined || catalogName === undefined) return undefined;
      const where = {
        subscriptionId,
        resourceGroupName,
        catalogName,
        productName: output?.productName ?? olds?.name ?? (yield* createAlphanumericName(id)),
      };
      const observed = yield* getProduct(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      return (yield* hasMarker(id, observed.properties?.description)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.AzureSphere");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        catalogName: news.catalog,
        productName: news.name ?? output?.productName ?? (yield* createAlphanumericName(id)),
      };
      const marker = yield* ownershipMarker(id);
      const description = descriptionWithMarker(news.description, marker);
      const waitReady = waitForProvisioned(
        `azure sphere product ${where.productName}`,
        getProduct(where),
        (product) => product.properties?.provisioningState,
      );

      // Observe.
      let observed = yield* getProduct(where);

      // Ensure.
      if (observed === undefined) {
        yield* sphere.ProductsCreateOrUpdate({ ...where, properties: { description } });
      }
      observed = yield* waitReady;

      // Sync the description against observed state.
      if (observed.properties?.description !== description) {
        yield* sphere.UpdateProduct({ ...where, properties: { description } });
        observed = yield* waitReady;
      }

      return toAttrs(where, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        catalogName: output.catalogName,
        productName: output.productName,
      };
      yield* ignoreNotFound(sphere.DeleteProduct(where));
      yield* waitUntilGone(`azure sphere product ${output.productName}`, getProduct(where));
    }),

    nuke: { dependsOn: ["Azure.AzureSphere.Catalog"] },
  });
