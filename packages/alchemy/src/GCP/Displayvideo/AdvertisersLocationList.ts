import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  hasOwnershipMarker,
  ignoreList,
  listAccessibleAdvertiserIds,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./ownership.ts";

const DEFAULT_LOCATION_TYPE = "TARGETING_LOCATION_TYPE_REGIONAL";

export type AdvertisersLocationListProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the list.
   */
  advertiserId: string;
  /**
   * System-assigned location list id. Omit on create; pass the observed
   * id to update in place.
   */
  locationListId?: string;
  /**
   * Location type shared by every entry. Immutable.
   * @default "TARGETING_LOCATION_TYPE_REGIONAL"
   */
  locationType?: string;
  /**
   * Display name (max 240 bytes). Location lists have no labels field,
   * so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  displayName?: string;
};

export type AdvertisersLocationList = Resource<
  "GCP.Displayvideo.AdvertisersLocationList",
  AdvertisersLocationListProps,
  {
    /** Resource name `advertisers/{advertiser}/locationLists/{list}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** System-assigned location list id. */
    locationListId: string;
    /** Location type. */
    locationType: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 location list under an advertiser.
 *
 * Lists have no labels field — Alchemy stamps ownership into the display
 * name so `list` / nuke can find them. Advertiser id and location type
 * are immutable. Display name updates in place. The DV360 API has no
 * location-list delete; destroy strips the ownership prefix so nuke will
 * ignore the leftover list.
 *
 * ### Creating a Location List
 * **Example:** Regional targeting list
 * ```typescript
 * const list = yield* GCP.Displayvideo.AdvertisersLocationList("Geo", {
 *   advertiserId: advertiser.advertiserId,
 *   locationType: "TARGETING_LOCATION_TYPE_REGIONAL",
 *   displayName: "us-regions",
 * });
 * ```
 *
 * ### Updating a Location List
 * **Example:** Rename the list
 * ```typescript
 * const list = yield* GCP.Displayvideo.AdvertisersLocationList("Geo", {
 *   advertiserId: existing.advertiserId,
 *   locationListId: existing.locationListId,
 *   locationType: "TARGETING_LOCATION_TYPE_REGIONAL",
 *   displayName: "us-regions-v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersLocationList = Resource<AdvertisersLocationList>(
  "GCP.Displayvideo.AdvertisersLocationList",
);

export class AdvertisersLocationListNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersLocationListNotResolved",
)<{
  locationListId: string;
}> {}

const toAttrs = (list: dv.LocationList) => {
  const parsed = parseOwnership(list.displayName);
  return {
    name: list.name ?? "",
    advertiserId: list.advertiserId ?? "",
    locationListId: list.locationListId ?? "",
    locationType: list.locationType,
    displayName: parsed.text,
  };
};

const getById = (advertiserId: string, locationListId: string | undefined) =>
  !locationListId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersLocationLists({ advertiserId, locationListId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string) =>
  dv.listAdvertisersLocationLists.pages({ advertiserId, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.locationLists ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.LocationList[]),
  );

const findByDisplayName = (advertiserId: string, displayName: string) =>
  listAt(advertiserId).pipe(
    Effect.map((lists) =>
      lists.find((list) => list.displayName === displayName),
    ),
  );

export const AdvertisersLocationListProvider = () =>
  Provider.succeed(AdvertisersLocationList, {
    stables: ["name", "advertiserId", "locationListId", "locationType"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        previousAdvertiser !== undefined &&
        news.advertiserId !== previousAdvertiser
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType =
        olds?.locationType ?? output?.locationType ?? DEFAULT_LOCATION_TYPE;
      const nextType = news.locationType ?? DEFAULT_LOCATION_TYPE;
      if (previousType !== nextType) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.locationListId ?? output?.locationListId;
      if (
        previousId !== undefined &&
        news.locationListId !== undefined &&
        news.locationListId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      let existing = yield* getById(
        advertiserId,
        olds?.locationListId ?? output?.locationListId,
      );
      if (existing === undefined && advertiserId) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          advertiserId,
          encodeOwnershipLine(ownership, olds?.displayName),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const advertiserIds = yield* listAccessibleAdvertiserIds();
        const pages = yield* Effect.forEach(
          advertiserIds,
          (advertiserId) => listAt(advertiserId),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((list) => hasOwnershipMarker(list.displayName))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const advertiserId = news.advertiserId;
      const locationType = news.locationType ?? DEFAULT_LOCATION_TYPE;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);

      let current = yield* getById(
        advertiserId,
        news.locationListId ?? output?.locationListId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(advertiserId, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersLocationLists({
            advertiserId,
            body: { advertiserId, displayName, locationType },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(advertiserId, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AdvertisersLocationListNotResolved({
          locationListId:
            news.locationListId ?? output?.locationListId ?? displayName,
        });
      }

      const locationListId = current.locationListId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      if (displayChanged) {
        current = yield* dv.patchAdvertisersLocationLists({
          advertiserId,
          locationListId,
          updateMask: updateMaskOf("displayName"),
          body: { advertiserId, locationListId, displayName, locationType },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId || !output.locationListId) return;
      // DV360 has no LocationLists.delete. Strip the ownership prefix so
      // list / nuke no longer treat the leftover list as Alchemy-owned.
      yield* dv
        .patchAdvertisersLocationLists({
          advertiserId: output.advertiserId,
          locationListId: output.locationListId,
          updateMask: updateMaskOf("displayName"),
          body: {
            locationListId: output.locationListId,
            displayName: output.displayName ?? "location-list",
          },
        })
        .pipe(
          Effect.catchTag(
            ["NotFound", "Forbidden"] as const,
            () => Effect.void,
          ),
        );
    }),
  });
