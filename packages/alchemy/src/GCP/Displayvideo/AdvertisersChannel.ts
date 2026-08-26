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

export type AdvertisersChannelProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the channel.
   */
  advertiserId: string;
  /**
   * Partner that owns the channel. Optional on advertiser-owned channels.
   */
  partnerId?: string;
  /**
   * System-assigned channel id. Omit on create; pass the observed id to
   * update in place.
   */
  channelId?: string;
  /**
   * Display name (max 240 bytes). Channels have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix and stripped
   * from attributes.
   */
  displayName?: string;
};

export type AdvertisersChannel = Resource<
  "GCP.Displayvideo.AdvertisersChannel",
  AdvertisersChannelProps,
  {
    /** Resource name `advertisers/{advertiser}/channels/{channel}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** Partner id, when the channel is partner-visible. */
    partnerId: string | undefined;
    /** System-assigned channel id. */
    channelId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Line items targeting this channel positively. */
    positivelyTargetedLineItemCount: string | undefined;
    /** Line items targeting this channel negatively. */
    negativelyTargetedLineItemCount: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 channel under an advertiser.
 *
 * Channels have no labels field — Alchemy stamps ownership into the
 * display name so `list` / nuke can find them. Advertiser id is
 * immutable. Display name updates in place. The DV360 API has no
 * channel delete; destroy strips the ownership prefix so nuke will
 * ignore the leftover channel.
 *
 * ### Creating a Channel
 * **Example:** Named site list
 * ```typescript
 * const channel = yield* GCP.Displayvideo.AdvertisersChannel("Premium", {
 *   advertiserId: advertiser.advertiserId,
 *   displayName: "premium-sites",
 * });
 * ```
 *
 * ### Updating a Channel
 * **Example:** Rename the channel
 * ```typescript
 * const channel = yield* GCP.Displayvideo.AdvertisersChannel("Premium", {
 *   advertiserId: existing.advertiserId,
 *   channelId: existing.channelId,
 *   displayName: "premium-sites-v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersChannel = Resource<AdvertisersChannel>(
  "GCP.Displayvideo.AdvertisersChannel",
);

export class AdvertisersChannelNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersChannelNotResolved",
)<{
  channelId: string;
}> {}

const toAttrs = (channel: dv.Channel, advertiserId: string) => {
  const parsed = parseOwnership(channel.displayName);
  return {
    name: channel.name ?? "",
    advertiserId: channel.advertiserId ?? advertiserId,
    partnerId: channel.partnerId,
    channelId: channel.channelId ?? "",
    displayName: parsed.text,
    positivelyTargetedLineItemCount: channel.positivelyTargetedLineItemCount,
    negativelyTargetedLineItemCount: channel.negativelyTargetedLineItemCount,
  };
};

const getById = (
  advertiserId: string,
  channelId: string | undefined,
  partnerId?: string,
) =>
  !channelId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersChannels({ advertiserId, channelId, partnerId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string, partnerId?: string) =>
  dv.listAdvertisersChannels
    .pages({ advertiserId, partnerId, pageSize: 200 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.channels ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dv.Channel[]),
    );

const findByDisplayName = (
  advertiserId: string,
  displayName: string,
  partnerId?: string,
) =>
  listAt(advertiserId, partnerId).pipe(
    Effect.map((channels) =>
      channels.find((channel) => channel.displayName === displayName),
    ),
  );

export const AdvertisersChannelProvider = () =>
  Provider.succeed(AdvertisersChannel, {
    stables: ["name", "advertiserId", "channelId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        previousAdvertiser !== undefined &&
        news.advertiserId !== previousAdvertiser
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.channelId ?? output?.channelId;
      if (
        previousId !== undefined &&
        news.channelId !== undefined &&
        news.channelId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      const partnerId = olds?.partnerId ?? output?.partnerId;
      let existing = yield* getById(
        advertiserId,
        olds?.channelId ?? output?.channelId,
        partnerId,
      );
      if (existing === undefined && advertiserId) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          advertiserId,
          encodeOwnershipLine(ownership, olds?.displayName),
          partnerId,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, advertiserId);
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
        return pages.flatMap((channels, i) => {
          const advertiserId = advertiserIds[i] ?? "";
          return channels
            .filter((channel) => hasOwnershipMarker(channel.displayName))
            .map((channel) => toAttrs(channel, advertiserId));
        });
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const advertiserId = news.advertiserId;
      const partnerId = news.partnerId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);

      let current = yield* getById(
        advertiserId,
        news.channelId ?? output?.channelId,
        partnerId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(
          advertiserId,
          displayName,
          partnerId,
        );
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersChannels({
            advertiserId,
            partnerId,
            body: { displayName, advertiserId, partnerId },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(advertiserId, displayName, partnerId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AdvertisersChannelNotResolved({
          channelId: news.channelId ?? output?.channelId ?? displayName,
        });
      }

      const channelId = current.channelId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      if (displayChanged) {
        current = yield* dv.patchAdvertisersChannels({
          advertiserId,
          channelId,
          partnerId,
          updateMask: updateMaskOf("displayName"),
          body: { channelId, advertiserId, partnerId, displayName },
        });
      }

      return toAttrs(current, advertiserId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId || !output.channelId) return;
      // DV360 has no Channels.delete. Strip the ownership prefix so list /
      // nuke no longer treat the leftover channel as Alchemy-owned.
      yield* dv
        .patchAdvertisersChannels({
          advertiserId: output.advertiserId,
          channelId: output.channelId,
          partnerId: output.partnerId,
          updateMask: updateMaskOf("displayName"),
          body: {
            channelId: output.channelId,
            displayName: output.displayName ?? "channel",
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
