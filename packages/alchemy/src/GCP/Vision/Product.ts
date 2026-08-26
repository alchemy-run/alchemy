import * as vision from "@distilled.cloud/gcp/vision_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_PRODUCT_CATEGORY,
  deleteProduct,
  encodeOwnershipLine,
  findOwnedProduct,
  getProduct,
  listOwnedProducts,
  locationParent,
  MAX_DESCRIPTION_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  normalizeLocation,
  ownershipLabels,
  parseOwnership,
  parseResourceName,
  productNameOf,
  productOwnedByAlchemy,
  replaceOnIdentity,
  sameProductLabels,
  sameText,
  stripAlchemyProductLabels,
  toResourceId,
  updateMaskOf,
  waitUntilGone,
  withAlchemyProductLabels,
} from "./internal.ts";

export type ProductLabel = {
  /** Label key (max 128 bytes). */
  key: string;
  /** Label value (max 128 bytes). */
  value: string;
};

export type ProductProps = {
  /**
   * Product Search location. Immutable — changing it replaces the
   * product.
   * @default "us-west1"
   */
  location?: string;
  /**
   * Product id (the `{product}` segment of
   * `projects/{project}/locations/{location}/products/{product}`). If
   * omitted, a unique id is generated. Immutable — changing it replaces
   * the product. At most 128 characters; cannot contain `/`.
   */
  productId?: string;
  /**
   * User-facing name (max 4096 characters). Alchemy also stamps
   * ownership here as a fallback for `list` / nuke.
   */
  displayName?: string;
  /**
   * User-provided metadata (max 4096 characters).
   */
  description?: string;
  /**
   * Immutable product category. One of `homegoods-v2`, `apparel-v2`,
   * `toys-v2`, `packagedgoods-v1`, or `general-v1`. Changing it replaces
   * the product.
   * @default "homegoods-v2"
   */
  productCategory?: string;
  /**
   * Search labels. Alchemy ownership labels are merged in automatically
   * and stripped from attributes.
   */
  productLabels?: ProductLabel[];
};

export type Product = Resource<
  "GCP.Vision.Product",
  ProductProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/products/{product}`. */
    name: string;
    /** Product id (last path segment). */
    productId: string;
    /** Project id. */
    project: string;
    /** Product Search location. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Product category. */
    productCategory: string | undefined;
    /** User product labels (Alchemy ownership labels stripped). */
    productLabels: ProductLabel[];
  },
  never,
  Providers
>;

/**
 * A Cloud Vision Product Search product. Products hold reference images
 * and can be added to one or more product sets.
 *
 * Alchemy stamps ownership into `productLabels` and `displayName` for
 * `list` / nuke. Location, product id, and `productCategory` are identity
 * — changing any of them replaces the product. Display name, description,
 * and labels update in place.
 *
 * ### Creating a Product
 * **Example:** Generated id
 * ```typescript
 * const product = yield* GCP.Vision.Product("Shoe", {
 *   displayName: "Trail runner",
 *   productCategory: "apparel-v2",
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const product = yield* GCP.Vision.Product("Shoe", {
 *   location: "us-west1",
 *   productId: "trail-runner",
 *   displayName: "Trail runner",
 *   productCategory: "apparel-v2",
 *   productLabels: [{ key: "color", value: "blue" }],
 * });
 * ```
 *
 * ### Updating a Product
 * **Example:** Rename and add a label
 * ```typescript
 * const product = yield* GCP.Vision.Product("Shoe", {
 *   location: "us-west1",
 *   productId: existing.productId,
 *   displayName: "Trail runner v2",
 *   productCategory: "apparel-v2",
 *   productLabels: [{ key: "color", value: "green" }],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Vision
 */
export const Product = Resource<Product>("GCP.Vision.Product");

export class ProductNotResolved extends Data.TaggedError(
  "GCP.Vision.ProductNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (product: vision.Product, project: string) => {
  const name = product.name ?? "";
  const parsed = parseResourceName(name, project, "products");
  return {
    name,
    productId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: parseOwnership(product.displayName).text,
    description: parseOwnership(product.description).text,
    productCategory: product.productCategory,
    productLabels: stripAlchemyProductLabels(product.productLabels),
  };
};

export const ProductProvider = () =>
  Provider.succeed(Product, {
    stables: ["name", "productId", "project", "location", "productCategory"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousCategory = olds?.productCategory ?? output?.productCategory;
      const nextCategory =
        news.productCategory ?? previousCategory ?? DEFAULT_PRODUCT_CATEGORY;
      return replaceOnIdentity({
        previousId: olds?.productId ?? output?.productId,
        nextId: news.productId,
        previousParent: locationParent(
          env.project,
          normalizeLocation(olds?.location ?? output?.location),
        ),
        nextParent: locationParent(
          env.project,
          normalizeLocation(news.location ?? output?.location),
        ),
        extra:
          previousCategory !== undefined && previousCategory !== nextCategory,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        productNameOf(
          env.project,
          location,
          olds?.productId ?? output?.productId ?? "",
        );
      let existing = yield* getProduct(name);
      if (existing === undefined) {
        existing = yield* findOwnedProduct(env.project, location, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* productOwnedByAlchemy(id, existing))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const products = yield* listOwnedProducts(env.project);
        return products.map((product) => toAttrs(product, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const ownership = yield* ownershipLabels(id);
      const productId = yield* toResourceId(
        id,
        news.productId,
        output?.productId,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName ?? productId,
        MAX_DISPLAY_NAME_LENGTH,
      );
      const description = encodeOwnershipLine(
        ownership,
        news.description,
        MAX_DESCRIPTION_LENGTH,
      );
      const productCategory =
        news.productCategory ??
        output?.productCategory ??
        DEFAULT_PRODUCT_CATEGORY;
      const productLabels = withAlchemyProductLabels(
        news.productLabels,
        ownership,
      );
      const name =
        output?.name ?? productNameOf(env.project, location, productId);

      let current = yield* getProduct(name);
      if (current === undefined) {
        current = yield* findOwnedProduct(env.project, location, id);
      }

      if (current === undefined) {
        const created = yield* vision
          .createProjectsLocationsProducts({
            parent: locationParent(env.project, location),
            productId,
            body: {
              displayName,
              description,
              productCategory,
              productLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getProduct(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ProductNotResolved({
          name: name || productNameOf(env.project, location, productId),
        });
      }

      const currentName = current.name ?? name;
      const observedLabels = stripAlchemyProductLabels(current.productLabels);
      const desiredUserLabels = stripAlchemyProductLabels(productLabels);
      const updateMask = updateMaskOf(
        sameText(current.displayName, displayName) ? undefined : "display_name",
        sameText(current.description, description) ? undefined : "description",
        sameProductLabels(observedLabels, desiredUserLabels)
          ? undefined
          : "product_labels",
      );

      if (updateMask.length > 0) {
        current = yield* vision.patchProjectsLocationsProducts({
          name: currentName,
          updateMask,
          body: {
            name: currentName,
            displayName,
            description,
            productLabels,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* deleteProduct(output.name);
      yield* waitUntilGone(getProduct(output.name));
    }),
  });
