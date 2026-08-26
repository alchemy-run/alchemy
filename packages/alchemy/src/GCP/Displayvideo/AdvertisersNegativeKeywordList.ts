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

export type AdvertisersNegativeKeywordListProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the list.
   */
  advertiserId: string;
  /**
   * System-assigned negative keyword list id. Omit on create; pass the
   * observed id to update in place.
   */
  negativeKeywordListId?: string;
  /**
   * Display name (max 255 bytes). Negative keyword lists have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  displayName?: string;
};

export type AdvertisersNegativeKeywordList = Resource<
  "GCP.Displayvideo.AdvertisersNegativeKeywordList",
  AdvertisersNegativeKeywordListProps,
  {
    /** Resource name `advertisers/{advertiser}/negativeKeywordLists/{list}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** System-assigned negative keyword list id. */
    negativeKeywordListId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Number of line items targeting this list. */
    targetedLineItemCount: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 negative keyword list under an advertiser.
 *
 * Lists have no labels field — Alchemy stamps ownership into the display
 * name so `list` / nuke can find them. Advertiser id is immutable. Display
 * name updates in place.
 *
 * ### Creating a Negative Keyword List
 * **Example:** Named exclusion list
 * ```typescript
 * const list = yield* GCP.Displayvideo.AdvertisersNegativeKeywordList("Brand", {
 *   advertiserId: advertiser.advertiserId,
 *   displayName: "brand-exclusions",
 * });
 * ```
 *
 * ### Updating a Negative Keyword List
 * **Example:** Rename the list
 * ```typescript
 * const list = yield* GCP.Displayvideo.AdvertisersNegativeKeywordList("Brand", {
 *   advertiserId: existing.advertiserId,
 *   negativeKeywordListId: existing.negativeKeywordListId,
 *   displayName: "brand-exclusions-v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersNegativeKeywordList =
  Resource<AdvertisersNegativeKeywordList>(
    "GCP.Displayvideo.AdvertisersNegativeKeywordList",
  );

export class AdvertisersNegativeKeywordListNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersNegativeKeywordListNotResolved",
)<{
  negativeKeywordListId: string;
}> {}

const toAttrs = (list: dv.NegativeKeywordList) => {
  const parsed = parseOwnership(list.displayName);
  return {
    name: list.name ?? "",
    advertiserId: list.advertiserId ?? "",
    negativeKeywordListId: list.negativeKeywordListId ?? "",
    displayName: parsed.text,
    targetedLineItemCount: list.targetedLineItemCount,
  };
};

const getById = (
  advertiserId: string,
  negativeKeywordListId: string | undefined,
) =>
  !negativeKeywordListId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersNegativeKeywordLists({
          advertiserId,
          negativeKeywordListId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string) =>
  dv.listAdvertisersNegativeKeywordLists
    .pages({ advertiserId, pageSize: 200 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.negativeKeywordLists ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dv.NegativeKeywordList[]),
    );

const findByDisplayName = (advertiserId: string, displayName: string) =>
  listAt(advertiserId).pipe(
    Effect.map((lists) =>
      lists.find((list) => list.displayName === displayName),
    ),
  );

export const AdvertisersNegativeKeywordListProvider = () =>
  Provider.succeed(AdvertisersNegativeKeywordList, {
    stables: ["name", "advertiserId", "negativeKeywordListId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        previousAdvertiser !== undefined &&
        news.advertiserId !== previousAdvertiser
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId =
        olds?.negativeKeywordListId ?? output?.negativeKeywordListId;
      if (
        previousId !== undefined &&
        news.negativeKeywordListId !== undefined &&
        news.negativeKeywordListId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      let existing = yield* getById(
        advertiserId,
        olds?.negativeKeywordListId ?? output?.negativeKeywordListId,
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
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName, 255);

      let current = yield* getById(
        advertiserId,
        news.negativeKeywordListId ?? output?.negativeKeywordListId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(advertiserId, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersNegativeKeywordLists({
            advertiserId,
            body: { displayName },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(advertiserId, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AdvertisersNegativeKeywordListNotResolved({
          negativeKeywordListId:
            news.negativeKeywordListId ??
            output?.negativeKeywordListId ??
            displayName,
        });
      }

      const negativeKeywordListId = current.negativeKeywordListId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      if (displayChanged) {
        current = yield* dv.patchAdvertisersNegativeKeywordLists({
          advertiserId,
          negativeKeywordListId,
          updateMask: updateMaskOf("displayName"),
          body: {
            advertiserId,
            negativeKeywordListId,
            displayName,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId || !output.negativeKeywordListId) return;
      yield* dv
        .deleteAdvertisersNegativeKeywordLists({
          advertiserId: output.advertiserId,
          negativeKeywordListId: output.negativeKeywordListId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
