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
  jsonEqual,
  listOwnedAdvertiserIds,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./ownership.ts";

export type CreativeDimensions = {
  /** Width in pixels. */
  widthPixels?: number;
  /** Height in pixels. */
  heightPixels?: number;
};

export type CreativeAsset = {
  /** Uploaded media id. */
  mediaId?: string;
  /** Asset content or serving path. */
  content?: string;
};

export type CreativeAssetAssociation = {
  /** Associated asset. */
  asset?: CreativeAsset;
  /** Asset role, for example `ASSET_ROLE_MAIN`. */
  role?: string;
};

export type CreativeExitEvent = {
  /** Click-through URL. */
  url?: string;
  /** `EXIT_EVENT_TYPE_DEFAULT` or `EXIT_EVENT_TYPE_BACKUP`. */
  type?: string;
  /** Click-tag name. Must be unique within the creative. */
  name?: string;
  /** Reporting name. */
  reportingName?: string;
};

export type AdvertisersCreativeProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the
   * creative.
   */
  advertiserId: string;
  /**
   * System-assigned creative id. Omit on create; pass the observed id
   * to update in place.
   */
  creativeId?: string;
  /**
   * Display name (max 240 bytes). Creatives have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and in
   * `notes`.
   */
  displayName?: string;
  /**
   * Creative type. Immutable.
   * @default "CREATIVE_TYPE_STANDARD"
   */
  creativeType?: string;
  /**
   * Hosting source.
   * @default "HOSTING_SOURCE_THIRD_PARTY"
   */
  hostingSource?: string;
  /**
   * Primary dimensions. Defaults to 300x250.
   */
  dimensions?: CreativeDimensions;
  /**
   * Serving status.
   * @default "ENTITY_STATUS_PAUSED"
   */
  entityStatus?: string;
  /**
   * Third-party HTML tag. Required for third-party standard and
   * expandable creatives.
   */
  thirdPartyTag?: string;
  /**
   * Exit events. At least one default exit is required.
   */
  exitEvents?: CreativeExitEvent[];
  /** Associated assets. */
  assets?: CreativeAssetAssociation[];
  /** Additional notes (Alchemy ownership is prefixed automatically). */
  notes?: string;
  /** Appended third-party HTML tracking tag. */
  appendedTag?: string;
  /** Landing-page URL of the default exit, used when `exitEvents` is omitted. */
  exitUrl?: string;
};

export type AdvertisersCreative = Resource<
  "GCP.Displayvideo.AdvertisersCreative",
  AdvertisersCreativeProps,
  {
    /** Resource name `advertisers/{advertiser}/creatives/{creative}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** System-assigned creative id. */
    creativeId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Creative type. */
    creativeType: string | undefined;
    /** Hosting source. */
    hostingSource: string | undefined;
    /** Primary dimensions. */
    dimensions: CreativeDimensions | undefined;
    /** Serving status. */
    entityStatus: string | undefined;
    /** Third-party HTML tag. */
    thirdPartyTag: string | undefined;
    /** Exit events. */
    exitEvents: CreativeExitEvent[] | undefined;
    /** User notes with the Alchemy ownership prefix stripped. */
    notes: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 creative under an advertiser.
 *
 * Creatives have no labels field — Alchemy stamps ownership into the
 * display name and notes so `list` / nuke can find them. Advertiser id
 * and creative type are immutable. Status, tag, exits, and notes update
 * in place.
 *
 * ### Creating a Creative
 * **Example:** Paused third-party 300x250 tag
 * ```typescript
 * const creative = yield* GCP.Displayvideo.AdvertisersCreative("Banner", {
 *   advertiserId: advertiser.advertiserId,
 *   displayName: "example-banner",
 *   thirdPartyTag: "<ins></ins>",
 *   exitUrl: "https://example.com",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersCreative = Resource<AdvertisersCreative>(
  "GCP.Displayvideo.AdvertisersCreative",
);

export class AdvertisersCreativeNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersCreativeNotResolved",
)<{
  creativeId: string;
}> {}

const DEFAULT_STATUS = "ENTITY_STATUS_PAUSED";
const DEFAULT_TYPE = "CREATIVE_TYPE_STANDARD";
const DEFAULT_HOST = "HOSTING_SOURCE_THIRD_PARTY";
const DEFAULT_TAG = "<ins></ins>";
const DEFAULT_EXIT = "https://example.com";

const defaultDimensions = (): CreativeDimensions => ({
  widthPixels: 300,
  heightPixels: 250,
});

const toAttrs = (creative: dv.Creative) => {
  const parsed = parseOwnership(creative.displayName);
  return {
    name: creative.name ?? "",
    advertiserId: creative.advertiserId ?? "",
    creativeId: creative.creativeId ?? "",
    displayName: parsed.text,
    creativeType: creative.creativeType,
    hostingSource: creative.hostingSource,
    dimensions: creative.dimensions,
    entityStatus: creative.entityStatus,
    thirdPartyTag: creative.thirdPartyTag,
    exitEvents: creative.exitEvents,
    notes: parseOwnership(creative.notes).text,
    createTime: creative.createTime,
    updateTime: creative.updateTime,
  };
};

const getById = (advertiserId: string, creativeId: string | undefined) =>
  !creativeId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersCreatives({ advertiserId, creativeId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string) =>
  dv.listAdvertisersCreatives.pages({ advertiserId, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.creatives ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.Creative[]),
  );

const findByDisplayName = (advertiserId: string, displayName: string) =>
  listAt(advertiserId).pipe(
    Effect.map((creatives) =>
      creatives.find((creative) => creative.displayName === displayName),
    ),
  );

const ownershipText = (creative: dv.Creative) =>
  creative.displayName ?? creative.notes;

export const AdvertisersCreativeProvider = () =>
  Provider.succeed(AdvertisersCreative, {
    stables: ["name", "advertiserId", "creativeId", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        previousAdvertiser !== undefined &&
        news.advertiserId !== previousAdvertiser
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType = olds?.creativeType ?? output?.creativeType;
      if (
        previousType !== undefined &&
        news.creativeType !== undefined &&
        news.creativeType !== previousType
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.creativeId ?? output?.creativeId;
      if (
        previousId !== undefined &&
        news.creativeId !== undefined &&
        news.creativeId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      let existing = yield* getById(
        advertiserId,
        olds?.creativeId ?? output?.creativeId,
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
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const advertiserIds = yield* listOwnedAdvertiserIds();
        const pages = yield* Effect.forEach(
          advertiserIds,
          (advertiserId) => listAt(advertiserId),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((creative) => hasOwnershipMarker(ownershipText(creative)))
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
      const displayName = encodeOwnershipLine(ownership, userName);
      const notes = encodeOwnershipLine(ownership, news.notes, 20000);
      const entityStatus = news.entityStatus ?? DEFAULT_STATUS;
      const creativeType = news.creativeType ?? DEFAULT_TYPE;
      const hostingSource = news.hostingSource ?? DEFAULT_HOST;
      const dimensions = news.dimensions ?? defaultDimensions();
      const thirdPartyTag = news.thirdPartyTag ?? DEFAULT_TAG;
      const exitEvents = news.exitEvents ?? [
        { type: "EXIT_EVENT_TYPE_DEFAULT", url: news.exitUrl ?? DEFAULT_EXIT },
      ];
      const assets = news.assets ?? [];

      let current = yield* getById(
        advertiserId,
        news.creativeId ?? output?.creativeId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(advertiserId, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersCreatives({
            advertiserId,
            body: {
              displayName,
              entityStatus,
              creativeType,
              hostingSource,
              dimensions,
              thirdPartyTag,
              exitEvents,
              assets,
              notes,
              appendedTag: news.appendedTag,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(advertiserId, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AdvertisersCreativeNotResolved({
          creativeId: news.creativeId ?? output?.creativeId ?? displayName,
        });
      }

      const creativeId = current.creativeId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const statusChanged = !sameText(current.entityStatus, entityStatus);
      const hostChanged = !sameText(current.hostingSource, hostingSource);
      const dimChanged = !jsonEqual(current.dimensions, dimensions);
      const tagChanged = !sameText(current.thirdPartyTag, thirdPartyTag);
      const exitChanged = !jsonEqual(current.exitEvents, exitEvents);
      const assetsChanged = !jsonEqual(current.assets, assets);
      const notesChanged = !sameText(current.notes, notes);
      const appendedChanged = !sameText(current.appendedTag, news.appendedTag);

      if (
        displayChanged ||
        statusChanged ||
        hostChanged ||
        dimChanged ||
        tagChanged ||
        exitChanged ||
        assetsChanged ||
        notesChanged ||
        appendedChanged
      ) {
        current = yield* dv.patchAdvertisersCreatives({
          advertiserId,
          creativeId,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            statusChanged ? "entityStatus" : undefined,
            hostChanged ? "hostingSource" : undefined,
            dimChanged ? "dimensions" : undefined,
            tagChanged ? "thirdPartyTag" : undefined,
            exitChanged ? "exitEvents" : undefined,
            assetsChanged ? "assets" : undefined,
            notesChanged ? "notes" : undefined,
            appendedChanged ? "appendedTag" : undefined,
          ),
          body: {
            advertiserId,
            creativeId,
            displayName,
            entityStatus,
            hostingSource,
            dimensions,
            thirdPartyTag,
            exitEvents,
            assets,
            notes,
            appendedTag: news.appendedTag,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId || !output.creativeId) return;
      yield* dv
        .deleteAdvertisersCreatives({
          advertiserId: output.advertiserId,
          creativeId: output.creativeId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
