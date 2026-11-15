import * as galaxy from "@distilled.cloud/starburst-galaxy";
import type { Privatelink } from "@distilled.cloud/starburst-galaxy/privatelink";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { findFirst } from "../internal.ts";
import { lookupOnlyLifecycle } from "../LookupOnly.ts";
import type { Providers } from "../Providers.ts";

/** Find a Galaxy PrivateLink connection by name or ID. */
export type PrivateLinkLookup =
  | {
      /** The connection's name, as Galaxy's console shows it. */
      readonly name: string;
    }
  | {
      /** The connection's ID (`pvtlnk-…`). */
      readonly privateLinkId: string;
    };

export interface PrivateLinkAttributes {
  /** Galaxy's PrivateLink ID (`pvtlnk-…`): pass it as a catalog's `privateLinkId`. */
  readonly privateLinkId: string;
  /** The connection's name. */
  readonly name: string;
  /** Galaxy cloud region the connection lives in, e.g. `aws-us-east1`. */
  readonly cloudRegionId: string;
}

export type PrivateLink = Resource<
  "StarburstGalaxy.Network.PrivateLink",
  PrivateLinkLookup,
  PrivateLinkAttributes,
  never,
  Providers,
  PrivateLinkLookup
>;

/**
 * A private network connection between Starburst Galaxy and a data source
 * in your cloud account (AWS PrivateLink, Azure Private Link): catalogs
 * reach their database through it instead of the internet.
 *
 * PrivateLink connections are only looked up. Starburst provisions them
 * with you through support; Galaxy's API can read them but not create or
 * delete one. Declaring `StarburstGalaxy.Network.PrivateLink(...)` in a stack fails
 * with `StarburstGalaxy.LookupOnlyResource`.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security-and-compliance/manage-cluster-connectivity/private-connections/aws-privatelink.html
 *
 * ### Looking up a connection
 * **Example:** A PostgreSQL catalog reached over PrivateLink
 * ```typescript
 * const link = StarburstGalaxy.Network.PrivateLink.lookup({ name: "rds-orders" });
 * const password = yield* Config.Redacted("ORDERS_READER_PASSWORD");
 * yield* StarburstGalaxy.Catalog.PostgresqlCatalog("Orders", {
 *   privateLinkId: link.privateLinkId,
 *   databaseName: "orders",
 *   username: "galaxy_reader",
 *   password,
 * });
 * ```
 *
 * @resource
 * @product Network
 */
export const PrivateLink = Resource<PrivateLink>("StarburstGalaxy.Network.PrivateLink");

const toAttributes = (link: Privatelink): PrivateLinkAttributes => ({
  privateLinkId: link.privatelinkId,
  name: link.name,
  cloudRegionId: link.cloudRegionId,
});

export const PrivateLinkProvider = () =>
  Provider.succeed(PrivateLink, {
    ...lookupOnlyLifecycle(
      "StarburstGalaxy.Network.PrivateLink",
      "Starburst provisions PrivateLink connections through support; Galaxy's API has no write operation for them",
    ),
    lookup: Effect.fn(function* (key) {
      // Galaxy refuses `name=` ids for PrivateLink ("Expected format: pvtlnk-NNNNNNNNNN"): names are matched on the list.
      const link =
        "privateLinkId" in key
          ? yield* galaxy.privatelink
              .getPrivateLink({ privatelinkId: key.privateLinkId })
              .pipe(Effect.catchTag("NotFound", () => Effect.undefined))
          : yield* findFirst(
              galaxy.privatelink.listPrivateLinks.items({}),
              (l) => l.name === key.name,
            );
      return link === undefined ? undefined : toAttributes(link);
    }),
  });
