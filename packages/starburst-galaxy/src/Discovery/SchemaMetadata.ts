import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Schema } from "@distilled.cloud/starburst-galaxy/discovery";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { type Contact, contactsOf, type Link, linksOf } from "../Contact.ts";
import type { Providers } from "../Providers.ts";

export interface SchemaMetadataProps {
  /** ID of the catalog holding the schema. Changing it replaces the resource. */
  readonly catalogId: string;
  /** Name of the schema to annotate. Changing it replaces the resource. */
  readonly schemaName: string;
  /**
   * Description the catalog explorer shows for the schema.
   * @default ""
   */
  readonly description?: string;
  /**
   * People to ask about the schema.
   * @default []
   */
  readonly contacts?: ReadonlyArray<Contact>;
  /**
   * Links shown on the schema (runbooks, dashboards, docs).
   * @default []
   */
  readonly links?: ReadonlyArray<Link>;
}

export interface SchemaMetadataAttributes {
  /** Catalog holding the schema. */
  readonly catalogId: string;
  /** The annotated schema. */
  readonly schemaName: string;
  /** Description the catalog explorer shows. */
  readonly description: string | undefined;
  /** People to ask about the schema. */
  readonly contacts: ReadonlyArray<Contact>;
  /** Links shown on the schema. */
  readonly links: ReadonlyArray<Link>;
  /** The role that owns the schema. */
  readonly ownerRoleId: string | undefined;
  /** Names of the tags applied to the schema. */
  readonly tags: ReadonlyArray<string>;
}

export type SchemaMetadata = Resource<
  "StarburstGalaxy.Discovery.SchemaMetadata",
  SchemaMetadataProps,
  SchemaMetadataAttributes,
  never,
  Providers
>;

/**
 * The description, contacts and links Starburst Galaxy's catalog explorer
 * shows for a schema. The schema itself comes from the catalog's data
 * source (a PostgreSQL schema, a lakehouse schema): this resource only
 * documents it.
 *
 * Everything but the catalog and schema updates in place; `destroy` clears
 * what the resource set and leaves the schema.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/explore-data/schema-level.html
 *
 * ### Documenting a schema
 * **Example:** A description and a runbook link
 * ```typescript
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 * yield* StarburstGalaxy.Discovery.SchemaMetadata("SalesDocs", {
 *   catalogId: shop.catalogId,
 *   schemaName: "sales",
 *   description: "Orders and refunds, loaded hourly",
 *   links: [{ name: "Runbook", uri: "https://wiki.example.com/sales" }],
 * });
 * ```
 *
 * @resource
 * @product Discovery
 */
export const SchemaMetadata = Resource<SchemaMetadata>("StarburstGalaxy.Discovery.SchemaMetadata");

const toAttributes = (catalogId: string, schema: Schema): SchemaMetadataAttributes => ({
  catalogId,
  schemaName: schema.schemaId,
  description: schema.description,
  contacts: contactsOf(schema.contacts),
  links: linksOf(schema.links),
  ownerRoleId: schema.owner?.roleId,
  tags: schema.tags.map((tag) => tag.name),
});

export const SchemaMetadataProvider = () =>
  Provider.succeed(SchemaMetadata, {
    stables: ["catalogId", "schemaName"],

    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (news.catalogId !== olds.catalogId || news.schemaName !== olds.schemaName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const schema = yield* galaxy.discovery
        .getCatalogSchema({ catalogId: output.catalogId, schemaId: output.schemaName })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      return schema === undefined ? undefined : toAttributes(output.catalogId, schema);
    }),

    reconcile: Effect.fn(function* ({ news, session }) {
      const ids = { catalogId: news.catalogId, schemaId: news.schemaName };
      // A missing schema fails with Galaxy's typed NotFound.
      let schema = yield* galaxy.discovery.getCatalogSchema(ids);
      const description = news.description ?? "";
      const contacts = contactsOf(news.contacts);
      const links = linksOf(news.links);
      const patch = {
        ...((schema.description ?? "") !== description ? { description } : {}),
        ...(!deepEqual(contactsOf(schema.contacts), contacts) ? { contacts } : {}),
        ...(!deepEqual(linksOf(schema.links), links) ? { links } : {}),
      };
      if (Object.keys(patch).length > 0) {
        yield* session.note(`Documenting schema ${news.schemaName}...`);
        schema = yield* galaxy.discovery.updateCatalogSchema({ ...ids, ...patch });
      }
      return toAttributes(news.catalogId, schema);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.discovery
        .updateCatalogSchema({
          catalogId: output.catalogId,
          schemaId: output.schemaName,
          description: "",
          contacts: [],
          links: [],
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () => Effect.succeed([]),
  });
