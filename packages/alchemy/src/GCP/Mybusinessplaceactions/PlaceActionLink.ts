import * as placeactions from "@distilled.cloud/gcp/mybusinessplaceactions_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_PLACE_ACTION_TYPE,
  deleteLink,
  findOwnedLink,
  hasOwnershipMarker,
  linkIdOf,
  listOwnedLinks,
  locationParent,
  ownedByAlchemy,
  ownershipLabels,
  parentOfName,
  parentsFromEnv,
  parseUriOwnership,
  sameText,
  stampUri,
  toGeneratedUri,
} from "./internal.ts";

export type PlaceActionType =
  | placeactions.PlaceActionLinkPlaceActionTypeEnum
  | (string & {});

export type PlaceActionLinkProps = {
  /**
   * Parent location (`locations/{location}` or the location id). Defaults
   * to `GCP_MYBUSINESS_LOCATION` / `GCP_PLACE_ACTION_PARENT`. Immutable —
   * changing it replaces the link.
   */
  parent?: string;
  /**
   * Resource name
   * `locations/{location}/placeActionLinks/{placeActionLink}`.
   * Server-assigned on create. Immutable — changing it replaces the
   * link.
   */
  name?: string;
  /**
   * Action URI. Required by the API. If omitted, a unique
   * `https://example.com/{name}` URI is generated. Place action links
   * have no labels field, so Alchemy stamps ownership into query
   * parameters (`alchemy-stack`, `alchemy-stage`, `alchemy-id`) and
   * strips them from attributes.
   */
  uri?: string;
  /**
   * Place action type (`SHOP_ONLINE`, `APPOINTMENT`, `FOOD_ORDERING`, …).
   * @default "SHOP_ONLINE"
   */
  placeActionType?: PlaceActionType;
  /**
   * Whether this link is the merchant-preferred link for its action
   * type at the location. Only one preferred link is allowed per type.
   * @default false
   */
  isPreferred?: boolean;
};

export type PlaceActionLink = Resource<
  "GCP.Mybusinessplaceactions.PlaceActionLink",
  PlaceActionLinkProps,
  {
    /** Resource name `locations/{location}/placeActionLinks/{placeActionLink}`. */
    name: string;
    /** Place action link id (last path segment). */
    placeActionLinkId: string;
    /** Parent location `locations/{location}`. */
    parent: string;
    /** Location id (last path segment of `parent`). */
    locationId: string;
    /** Project id used when the link was reconciled. */
    project: string;
    /** Action URI with Alchemy ownership query parameters stripped. */
    uri: string | undefined;
    /** Place action type. */
    placeActionType: string | undefined;
    /** Provider type (`MERCHANT` or `AGGREGATOR_3P`). */
    providerType: string | undefined;
    /** Whether the merchant prefers this link. */
    isPreferred: boolean;
    /** Whether the client can edit this link. */
    isEditable: boolean | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Business Profile place action link.
 *
 * Place action links have no labels field, so Alchemy stamps ownership
 * into the URI query string for `list` / nuke. Parent location and
 * resource name are identity — changing either replaces the link. URI,
 * place action type, and preferred flag update in place. Creating a
 * link requires the My Business Place Actions API and
 * `https://www.googleapis.com/auth/business.manage` on a Business
 * Profile location.
 *
 * ### Creating a Place Action Link
 * **Example:** Shop-online link
 * ```typescript
 * const link = yield* GCP.Mybusinessplaceactions.PlaceActionLink("Shop", {
 *   parent: "locations/123",
 *   uri: "https://example.com/shop",
 *   placeActionType: "SHOP_ONLINE",
 * });
 * ```
 *
 * **Example:** Preferred appointment booking
 * ```typescript
 * const link = yield* GCP.Mybusinessplaceactions.PlaceActionLink("Book", {
 *   parent: location.name,
 *   uri: "https://example.com/book",
 *   placeActionType: "APPOINTMENT",
 *   isPreferred: true,
 * });
 * ```
 *
 * ### Updating a Place Action Link
 * **Example:** Change the URI
 * ```typescript
 * const link = yield* GCP.Mybusinessplaceactions.PlaceActionLink("Shop", {
 *   name: existing.name,
 *   parent: existing.parent,
 *   uri: "https://example.com/shop-v2",
 *   placeActionType: "SHOP_ONLINE",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Mybusinessplaceactions
 */
export const PlaceActionLink = Resource<PlaceActionLink>(
  "GCP.Mybusinessplaceactions.PlaceActionLink",
);

export class PlaceActionLinkNotResolved extends Data.TaggedError(
  "GCP.Mybusinessplaceactions.PlaceActionLinkNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  link: placeactions.PlaceActionLink,
  project: string,
  parentHint?: string,
) => {
  const name = link.name ?? "";
  const parent = parentOfName(name) || locationParent(parentHint);
  return {
    name,
    placeActionLinkId: linkIdOf(name),
    parent,
    locationId: lastLocationId(parent),
    project,
    uri: parseUriOwnership(link.uri).uri,
    placeActionType: link.placeActionType,
    providerType: link.providerType,
    isPreferred: link.isPreferred === true,
    isEditable: link.isEditable,
    createTime: link.createTime,
    updateTime: link.updateTime,
  };
};

const lastLocationId = (parent: string) =>
  parent.length === 0 ? "" : (parent.split("/").filter(Boolean).at(-1) ?? "");

const desiredType = (
  news: PlaceActionLinkProps,
  current: placeactions.PlaceActionLink | undefined,
) =>
  news.placeActionType ?? current?.placeActionType ?? DEFAULT_PLACE_ACTION_TYPE;

const desiredPreferred = (
  news: PlaceActionLinkProps,
  current: placeactions.PlaceActionLink | undefined,
) => news.isPreferred ?? current?.isPreferred === true;

export const PlaceActionLinkProvider = () =>
  Provider.succeed(PlaceActionLink, {
    stables: [
      "name",
      "placeActionLinkId",
      "parent",
      "locationId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (
        previousParent !== undefined &&
        news.parent !== undefined &&
        locationParent(news.parent) !== locationParent(previousParent)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousName = olds?.name ?? output?.name;
      if (
        previousName !== undefined &&
        news.name !== undefined &&
        news.name !== previousName
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* findOwnedLink(id, {
        name: olds?.name ?? output?.name,
        parent: olds?.parent ?? output?.parent,
        uri: olds?.uri ?? output?.uri,
        placeActionType: olds?.placeActionType ?? output?.placeActionType,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        env.project,
        olds?.parent ?? output?.parent,
      );
      return (yield* ownedByAlchemy(id, existing.uri)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const links = yield* listOwnedLinks();
        return links
          .filter((link) => hasOwnershipMarker(link.uri))
          .map((link) => toAttrs(link, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const fromNews = locationParent(
        news.parent ??
          output?.parent ??
          parentOfName(news.name ?? output?.name ?? ""),
      );
      const parent =
        fromNews.length > 0 ? fromNews : (parentsFromEnv()[0] ?? "");
      const labels = yield* ownershipLabels(id);
      const baseUri = yield* toGeneratedUri(id, news.uri, output?.uri);
      const uri = stampUri(baseUri, labels);
      const placeActionType = desiredType(news, undefined);
      const isPreferred = desiredPreferred(news, undefined);

      let current = yield* findOwnedLink(id, {
        name: news.name ?? output?.name,
        parent,
        uri: baseUri,
        placeActionType,
      });

      if (current === undefined) {
        const created = yield* placeactions
          .createLocationsPlaceActionLinks({
            parent,
            body: {
              uri,
              placeActionType,
              isPreferred: isPreferred ? true : undefined,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwnedLink(id, {
                name: news.name ?? output?.name,
                parent,
                uri: baseUri,
                placeActionType,
              }),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PlaceActionLinkNotResolved({
          name: news.name ?? output?.name ?? `${parent}/placeActionLinks/-`,
        });
      }

      const name = current.name ?? "";
      const nextType = desiredType(news, current);
      const nextPreferred = desiredPreferred(news, current);
      const uriChanged = !sameText(current.uri, uri);
      const typeChanged = !sameText(current.placeActionType, nextType);
      const preferredChanged = (current.isPreferred === true) !== nextPreferred;
      const updateMask = [
        uriChanged ? "uri" : undefined,
        typeChanged ? "placeActionType" : undefined,
        preferredChanged ? "isPreferred" : undefined,
      ].filter((field): field is string => field !== undefined);

      if (updateMask.length > 0) {
        current = yield* placeactions.patchLocationsPlaceActionLinks({
          name,
          updateMask: updateMask.join(","),
          body: {
            uri,
            placeActionType: nextType,
            isPreferred: nextPreferred,
          },
        });
      }

      return toAttrs(current, env.project, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteLink(output.name);
    }),
  });
