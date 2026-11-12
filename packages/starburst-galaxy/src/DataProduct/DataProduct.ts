import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { DataProductV2 } from "@distilled.cloud/starburst-galaxy/data_product";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { type Contact, contactsOf, type Link, linksOf } from "../Contact.ts";
import {
  changedFields,
  collectAll,
  DATA_DOMAIN_NAME,
  findFirst,
  hasChanges,
  isGeneratedName,
  ownership,
  physicalName,
} from "../internal.ts";
import type { Providers } from "../Providers.ts";

export interface DataProductProps {
  /**
   * Data product name, as Galaxy's catalog shows it (free text). Renaming
   * updates the product in place.
   * @default generated from the stack, logical id and stage
   */
  readonly name?: string;
  /** One-line summary shown in listings. */
  readonly summary: string;
  /** Longer description (Markdown). */
  readonly description?: string;
  /** ID of the catalog holding the product's schema. Changing it replaces the product. */
  readonly catalogId: string;
  /** Schema in the catalog the product publishes. Changing it replaces the product. */
  readonly schemaName: string;
  /**
   * ID of the data domain the product belongs to (see `StarburstGalaxy.DataDomain`).
   * @default the account's default domain
   */
  readonly dataDomainId?: string;
  /**
   * People to ask about the product.
   * @default []
   */
  readonly contacts?: ReadonlyArray<Contact>;
  /**
   * Links shown on the product.
   * @default []
   */
  readonly links?: ReadonlyArray<Link>;
  /** ID of the cluster Galaxy suggests for querying the product. */
  readonly defaultClusterId?: string;
  /** Business context for Galaxy's AI features (who uses the data, and for what). */
  readonly businessContext?: string;
}

export interface DataProductAttributes {
  /** Galaxy's data product ID (`dp-…`). */
  readonly dataProductId: string;
  /** Data product name. */
  readonly name: string;
  /** One-line summary. */
  readonly summary: string;
  /** Longer description. */
  readonly description: string | undefined;
  /** Catalog holding the product's schema. */
  readonly catalogId: string | undefined;
  /** Name of that catalog. */
  readonly catalogName: string | undefined;
  /** Schema the product publishes. */
  readonly schemaName: string | undefined;
  /** Data domain the product belongs to. */
  readonly dataDomainId: string;
  /** People to ask about the product. */
  readonly contacts: ReadonlyArray<Contact>;
  /** Links shown on the product. */
  readonly links: ReadonlyArray<Link>;
  /** Cluster Galaxy suggests for querying, if set. */
  readonly defaultClusterId: string | undefined;
  /** Business context, if set. */
  readonly businessContext: string | undefined;
  /** Creation time. */
  readonly createdOn: string;
}

export type DataProduct = Resource<
  "StarburstGalaxy.DataProduct",
  DataProductProps,
  DataProductAttributes,
  never,
  Providers
>;

/** Galaxy accepted a data product create but the product could not be read back. */
export class DataProductNotResolved extends Data.TaggedError(
  "StarburstGalaxy.DataProductNotResolved",
)<{ readonly productName: string }> {
  override get message() {
    return `Data product "${this.productName}" could not be found after it was created`;
  }
}

/**
 * A Starburst Galaxy data product: one schema of a catalog published with
 * a summary, description, contacts and links, in a data domain, so others
 * find and query it from Galaxy's data product catalog.
 *
 * Everything but the catalog and schema updates in place (the name
 * included); moving the product to another catalog or schema replaces it.
 * Add example queries with `StarburstGalaxy.DataProductUsageExample`.
 *
 * Data products have no labels or tags in Galaxy: a product Alchemy
 * created is recognized by its generated name.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/data-products/create-data-products.html
 *
 * ### Publishing a schema
 * **Example:** The orders schema of a catalog, in its own domain
 * ```typescript
 * const sales = yield* StarburstGalaxy.DataDomain("Sales", { description: "Sales data" });
 * const shop = StarburstGalaxy.PostgresqlCatalog.lookup({ name: "shop" });
 * yield* StarburstGalaxy.DataProduct("Orders", {
 *   name: "Orders",
 *   summary: "Every order placed in the shop",
 *   catalogId: shop.catalogId,
 *   schemaName: "orders",
 *   dataDomainId: sales.dataDomainId,
 *   links: [{ name: "Runbook", uri: "https://wiki.example.com/orders" }],
 * });
 * ```
 *
 * ### Naming a contact
 * **Example:** The person who owns the data
 * ```typescript
 * const owner = StarburstGalaxy.User.lookup({ email: "ada@example.com" });
 * const shop = StarburstGalaxy.PostgresqlCatalog.lookup({ name: "shop" });
 * yield* StarburstGalaxy.DataProduct("Orders", {
 *   summary: "Every order placed in the shop",
 *   catalogId: shop.catalogId,
 *   schemaName: "orders",
 *   contacts: [{ userId: owner.userId, email: owner.email }],
 * });
 * ```
 *
 * @resource
 * @product Data products
 */
export const DataProduct = Resource<DataProduct>("StarburstGalaxy.DataProduct");

const toAttributes = (product: DataProductV2): DataProductAttributes => ({
  dataProductId: product.dataProductId,
  name: product.name,
  summary: product.summary,
  description: product.description,
  catalogId: product.catalog?.catalogId,
  catalogName: product.catalog?.catalogName,
  schemaName: product.schemaName,
  dataDomainId: product.dataDomainId,
  contacts: contactsOf(product.contacts),
  links: linksOf(product.links),
  defaultClusterId: product.defaultClusterId,
  businessContext: product.businessContext,
  createdOn: product.createdOn,
});

const getProduct = (dataProductId: string) =>
  galaxy.dataProduct
    .getDataProduct({ dataProductId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (name: string) =>
  findFirst(galaxy.dataProduct.listDataProducts.items({}), (product) => product.name === name);

const observe = Effect.fn(function* (dataProductId: string | undefined, name: string) {
  if (dataProductId !== undefined) {
    const byId = yield* getProduct(dataProductId);
    if (byId !== undefined) return byId;
  }
  return yield* findByName(name);
});

export const DataProductProvider = () =>
  Provider.succeed(DataProduct, {
    stables: ["dataProductId", "createdOn"],

    nuke: {
      // Products sit in a domain and on a catalog: delete them first.
      dependsOn: ["StarburstGalaxy.DataDomain", "StarburstGalaxy.*Catalog"],
    },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (news.catalogId !== olds.catalogId || news.schemaName !== olds.schemaName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const name = output?.name ?? (yield* physicalName(id, olds?.name, DATA_DOMAIN_NAME));
      const product = yield* observe(output?.dataProductId, name);
      if (product === undefined) return undefined;
      return ownership(toAttributes(product), {
        output,
        explicitName: olds?.name,
        previous,
        key: "dataProductId",
      });
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const name = yield* physicalName(id, news.name, DATA_DOMAIN_NAME);

      // Observe
      let product = yield* observe(output?.dataProductId, name);

      // Ensure: a create carries the whole desired state.
      if (product === undefined) {
        yield* session.note(`Creating data product ${name}...`);
        const created = yield* galaxy.dataProduct
          .createDataProduct({
            name,
            summary: news.summary,
            description: news.description,
            catalogId: news.catalogId,
            schemaName: news.schemaName,
            contacts: contactsOf(news.contacts),
            links: linksOf(news.links),
            defaultClusterId: news.defaultClusterId,
            businessContext: news.businessContext,
            dataDomain:
              news.dataDomainId === undefined
                ? { referenceType: "default" }
                : { referenceType: "id", id: news.dataDomainId },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        product = created ?? (yield* findByName(name));
        if (product === undefined) return yield* new DataProductNotResolved({ productName: name });
        return toAttributes(product);
      }

      // Sync: PATCH what differs from what Galaxy reports.
      const observed = toAttributes(product);
      const delta = changedFields(
        { ...observed, description: observed.description ?? "" },
        {
          name,
          summary: news.summary,
          description: news.description ?? "",
          defaultClusterId: news.defaultClusterId,
          businessContext: news.businessContext,
          dataDomainId: news.dataDomainId,
        },
      );
      const contacts = contactsOf(news.contacts);
      const links = linksOf(news.links);
      const contactsChanged = !deepEqual(observed.contacts, contacts);
      const linksChanged = !deepEqual(observed.links, links);
      if (hasChanges(delta) || contactsChanged || linksChanged) {
        yield* session.note(`Updating data product ${name}...`);
        product = yield* galaxy.dataProduct.updateDataProduct({
          ...delta,
          ...(contactsChanged ? { contacts } : {}),
          ...(linksChanged ? { links } : {}),
          dataProductId: product.dataProductId,
        });
      }
      return toAttributes(product);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.dataProduct
        .deleteDataProduct({ dataProductId: output.dataProductId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () =>
      collectAll(
        galaxy.dataProduct.listDataProducts
          .items({})
          .pipe(Stream.filter((item) => isGeneratedName(item.name))),
        toAttributes,
      ),
  });
