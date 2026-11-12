import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { CatalogMetadata as CatalogMetadataShape } from "@distilled.cloud/starburst-galaxy/discovery";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { type Contact, contactsOf } from "../Contact.ts";
import type { Providers } from "../Providers.ts";

export interface CatalogMetadataProps {
  /** ID of the catalog to annotate. Changing it replaces the resource. */
  readonly catalogId: string;
  /** People to ask about the catalog. */
  readonly contacts: ReadonlyArray<Contact>;
}

export interface CatalogMetadataAttributes {
  /** The annotated catalog. */
  readonly catalogId: string;
  /** The catalog's name. */
  readonly catalogName: string;
  /** The catalog's description (set on the catalog resource). */
  readonly description: string | undefined;
  /** The role that owns the catalog. */
  readonly ownerRoleId: string | undefined;
  /** People to ask about the catalog. */
  readonly contacts: ReadonlyArray<Contact>;
  /** Names of the tags applied to the catalog. */
  readonly tags: ReadonlyArray<string>;
}

export type CatalogMetadata = Resource<
  "StarburstGalaxy.Discovery.CatalogMetadata",
  CatalogMetadataProps,
  CatalogMetadataAttributes,
  never,
  Providers
>;

/**
 * The contacts Starburst Galaxy's catalog explorer shows for a catalog:
 * who to ask about its data. The catalog itself (and its description)
 * belongs to its catalog resource; tags belong to `TagAssignment`.
 *
 * It annotates a catalog the resource does not own: `destroy` clears the
 * contacts and leaves the catalog. Changing the contacts updates in place.
 *
 * @see https://docs.starburst.io/starburst-galaxy/working-with-data/explore-data/catalog-level.html
 *
 * ### Naming a catalog's contacts
 * **Example:** The data owner of an orders catalog
 * ```typescript
 * const owner = StarburstGalaxy.User.User.lookup({ email: "ada@example.com" });
 * const shop = StarburstGalaxy.Catalog.PostgresqlCatalog.lookup({ name: "shop" });
 * yield* StarburstGalaxy.Discovery.CatalogMetadata("ShopContacts", {
 *   catalogId: shop.catalogId,
 *   contacts: [{ userId: owner.userId, email: owner.email }],
 * });
 * ```
 *
 * @resource
 * @product Discovery
 */
export const CatalogMetadata = Resource<CatalogMetadata>(
  "StarburstGalaxy.Discovery.CatalogMetadata",
);

const toAttributes = (metadata: CatalogMetadataShape): CatalogMetadataAttributes => ({
  catalogId: metadata.catalogId,
  catalogName: metadata.catalogName,
  description: metadata.description,
  ownerRoleId: metadata.owner?.roleId,
  contacts: contactsOf(metadata.contacts),
  tags: metadata.tags.map((tag) => tag.name),
});

const setContacts = (catalogId: string, contacts: ReadonlyArray<Contact>) =>
  galaxy.discovery.updateCatalogMetadata({ catalogId, contacts: contactsOf(contacts) });

export const CatalogMetadataProvider = () =>
  Provider.succeed(CatalogMetadata, {
    stables: ["catalogId", "catalogName"],

    // An annotation, not an object: nothing to list, and the catalog's
    // deletion removes it.
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (news.catalogId !== olds.catalogId) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      // Only state knows the annotation is ours.
      if (output === undefined) return undefined;
      const metadata = yield* galaxy.discovery
        .getCatalogMetadata({ catalogId: output.catalogId })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      return metadata === undefined ? undefined : toAttributes(metadata);
    }),

    reconcile: Effect.fn(function* ({ news, session }) {
      // A missing catalog fails with Galaxy's typed NotFound.
      let metadata = yield* galaxy.discovery.getCatalogMetadata({ catalogId: news.catalogId });
      if (!deepEqual(contactsOf(metadata.contacts), contactsOf(news.contacts))) {
        yield* session.note(`Setting the contacts of catalog ${metadata.catalogName}...`);
        metadata = yield* setContacts(news.catalogId, news.contacts);
      }
      return toAttributes(metadata);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* setContacts(output.catalogId, []).pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    list: () => Effect.succeed([]),
  });
