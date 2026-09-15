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
  listAccessiblePartnerIds,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./ownership.ts";

export type PartnersChannelProps = {
  /**
   * Parent partner id. Immutable — changing it replaces the channel.
   */
  partnerId: string;
  /**
   * Advertiser that can use the channel. Optional on partner-owned
   * channels.
   */
  advertiserId?: string;
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

export type PartnersChannel = Resource<
  "GCP.Displayvideo.PartnersChannel",
  PartnersChannelProps,
  {
    /** Resource name `partners/{partner}/channels/{channel}`. */
    name: string;
    /** Parent partner id. */
    partnerId: string;
    /** Advertiser id, when the channel is advertiser-visible. */
    advertiserId: string | undefined;
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
 * A Display and Video 360 channel under a partner.
 *
 * Channels have no labels field — Alchemy stamps ownership into the
 * display name so `list` / nuke can find them. Partner id is immutable.
 * Display name updates in place. The DV360 API has no channel delete;
 * destroy strips the ownership prefix so nuke will ignore the leftover
 * channel.
 *
 * ### Creating a Partner Channel
 * **Example:** Named site list
 * ```typescript
 * const channel = yield* GCP.Displayvideo.PartnersChannel("Premium", {
 *   partnerId: "123",
 *   displayName: "premium-sites",
 * });
 * ```
 *
 * ### Updating a Partner Channel
 * **Example:** Rename the channel
 * ```typescript
 * const channel = yield* GCP.Displayvideo.PartnersChannel("Premium", {
 *   partnerId: existing.partnerId,
 *   channelId: existing.channelId,
 *   displayName: "premium-sites-v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const PartnersChannel = Resource<PartnersChannel>(
  "GCP.Displayvideo.PartnersChannel",
);

export class PartnersChannelNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.PartnersChannelNotResolved",
)<{
  channelId: string;
}> {}

const toAttrs = (channel: dv.Channel, partnerId: string) => {
  const parsed = parseOwnership(channel.displayName);
  return {
    name: channel.name ?? "",
    partnerId: channel.partnerId ?? partnerId,
    advertiserId: channel.advertiserId,
    channelId: channel.channelId ?? "",
    displayName: parsed.text,
    positivelyTargetedLineItemCount: channel.positivelyTargetedLineItemCount,
    negativelyTargetedLineItemCount: channel.negativelyTargetedLineItemCount,
  };
};

const getById = (
  partnerId: string,
  channelId: string | undefined,
  advertiserId?: string,
) =>
  !channelId
    ? Effect.succeed(undefined)
    : dv
        .getPartnersChannels({ partnerId, channelId, advertiserId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (partnerId: string, advertiserId?: string) =>
  dv.listPartnersChannels
    .pages({ partnerId, advertiserId, pageSize: 200 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.channels ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dv.Channel[]),
    );

const findByDisplayName = (
  partnerId: string,
  displayName: string,
  advertiserId?: string,
) =>
  listAt(partnerId, advertiserId).pipe(
    Effect.map((channels) =>
      channels.find((channel) => channel.displayName === displayName),
    ),
  );

export const PartnersChannelProvider = () =>
  Provider.succeed(PartnersChannel, {
    stables: ["name", "partnerId", "channelId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPartner = olds?.partnerId ?? output?.partnerId;
      if (previousPartner !== undefined && news.partnerId !== previousPartner) {
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
      const partnerId = olds?.partnerId ?? output?.partnerId ?? "";
      const advertiserId = olds?.advertiserId ?? output?.advertiserId;
      let existing = yield* getById(
        partnerId,
        olds?.channelId ?? output?.channelId,
        advertiserId,
      );
      if (existing === undefined && partnerId) {
        const ownership = yield* createInternalLabels(id);
        existing = yield* findByDisplayName(
          partnerId,
          encodeOwnershipLine(ownership, olds?.displayName),
          advertiserId,
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, partnerId);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const partnerIds = yield* listAccessiblePartnerIds();
        const pages = yield* Effect.forEach(
          partnerIds,
          (partnerId) => listAt(partnerId),
          { concurrency: 4 },
        );
        return pages.flatMap((channels, i) => {
          const partnerId = partnerIds[i] ?? "";
          return channels
            .filter((channel) => hasOwnershipMarker(channel.displayName))
            .map((channel) => toAttrs(channel, partnerId));
        });
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const partnerId = news.partnerId;
      const advertiserId = news.advertiserId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);

      let current = yield* getById(
        partnerId,
        news.channelId ?? output?.channelId,
        advertiserId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(
          partnerId,
          displayName,
          advertiserId,
        );
      }

      if (current === undefined) {
        const created = yield* dv
          .createPartnersChannels({
            partnerId,
            advertiserId,
            body: { displayName, partnerId, advertiserId },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(partnerId, displayName, advertiserId),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PartnersChannelNotResolved({
          channelId: news.channelId ?? output?.channelId ?? displayName,
        });
      }

      const channelId = current.channelId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      if (displayChanged) {
        current = yield* dv.patchPartnersChannels({
          partnerId,
          channelId,
          advertiserId,
          updateMask: updateMaskOf("displayName"),
          body: { channelId, partnerId, advertiserId, displayName },
        });
      }

      return toAttrs(current, partnerId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.partnerId || !output.channelId) return;
      // DV360 has no Channels.delete. Strip the ownership prefix so list /
      // nuke no longer treat the leftover channel as Alchemy-owned.
      yield* dv
        .patchPartnersChannels({
          partnerId: output.partnerId,
          channelId: output.channelId,
          advertiserId: output.advertiserId,
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
