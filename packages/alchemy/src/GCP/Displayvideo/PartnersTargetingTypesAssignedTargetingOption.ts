import * as dv from "@distilled.cloud/gcp/displayvideo_v4";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { ignoreList, jsonEqual } from "./ownership.ts";
import {
  assignedBody,
  CHANNEL_TARGETING_TYPE,
  detailsFromOption,
  parseAssignedName,
  type AssignedTargetingDetails,
} from "./targeting.ts";

export type PartnersTargetingTypesAssignedTargetingOptionProps = {
  /**
   * Parent partner id. Immutable — changing it replaces the assignment.
   */
  partnerId: string;
  /**
   * Targeting type. Partner assignments support `TARGETING_TYPE_CHANNEL`
   * only. Immutable.
   * @default "TARGETING_TYPE_CHANNEL"
   */
  targetingType?: string;
  /**
   * System-assigned option id. Omit on create; pass the observed id to
   * target an existing assignment.
   */
  assignedTargetingOptionId?: string;
  /**
   * Channel targeting. Required on create. `channelId` must refer to a
   * partner-owned channel.
   */
  channelDetails: NonNullable<AssignedTargetingDetails["channelDetails"]>;
};

export type PartnersTargetingTypesAssignedTargetingOption = Resource<
  "GCP.Displayvideo.PartnersTargetingTypesAssignedTargetingOption",
  PartnersTargetingTypesAssignedTargetingOptionProps,
  {
    /** Resource name `partners/{partner}/targetingTypes/{type}/assignedTargetingOptions/{id}`. */
    name: string;
    /** Parent partner id. */
    partnerId: string;
    /** Targeting type. */
    targetingType: string;
    /** System-assigned option id. */
    assignedTargetingOptionId: string;
    /** Alias for the option id when the targeting type supports one. */
    assignedTargetingOptionIdAlias: string | undefined;
    /** Inheritance status. */
    inheritance: string | undefined;
    /** Channel targeting. */
    channelDetails: AssignedTargetingDetails["channelDetails"];
  },
  never,
  Providers
>;

/**
 * A targeting option assigned to a Display and Video 360 partner.
 *
 * Partner assignments only support `TARGETING_TYPE_CHANNEL`. Channel
 * details are identity — changing `channelId` replaces the assignment.
 * Channel options have no labels or description, so `list` / nuke match
 * by observed channel id under partners Alchemy can enumerate.
 *
 * ### Creating a Partner Assigned Targeting Option
 * **Example:** Negative channel on a partner
 * ```typescript
 * const option = yield* GCP.Displayvideo.PartnersTargetingTypesAssignedTargetingOption("Block", {
 *   partnerId: "123",
 *   targetingType: "TARGETING_TYPE_CHANNEL",
 *   channelDetails: { channelId: "456", negative: true },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const PartnersTargetingTypesAssignedTargetingOption =
  Resource<PartnersTargetingTypesAssignedTargetingOption>(
    "GCP.Displayvideo.PartnersTargetingTypesAssignedTargetingOption",
  );

export class PartnersTargetingTypesAssignedTargetingOptionNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.PartnersTargetingTypesAssignedTargetingOptionNotResolved",
)<{
  assignedTargetingOptionId: string;
}> {}

const toAttrs = (
  option: dv.AssignedTargetingOption,
  partnerId: string,
  targetingType: string,
) => {
  const parsed = parseAssignedName(option.name ?? "");
  const details = detailsFromOption(option);
  return {
    name: option.name ?? "",
    partnerId: parsed.partnerId || partnerId,
    targetingType:
      option.targetingType ?? (parsed.targetingType || targetingType),
    assignedTargetingOptionId:
      option.assignedTargetingOptionId ?? parsed.assignedTargetingOptionId,
    assignedTargetingOptionIdAlias: option.assignedTargetingOptionIdAlias,
    inheritance: option.inheritance,
    channelDetails: details.channelDetails,
  };
};

const getById = (
  partnerId: string,
  targetingType: string,
  assignedTargetingOptionId: string | undefined,
) =>
  !assignedTargetingOptionId
    ? Effect.succeed(undefined)
    : dv
        .getPartnersTargetingTypesAssignedTargetingOptions({
          partnerId,
          targetingType,
          assignedTargetingOptionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (partnerId: string, targetingType: string) =>
  dv.listPartnersTargetingTypesAssignedTargetingOptions
    .pages({ partnerId, targetingType, pageSize: 200 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.assignedTargetingOptions ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dv.AssignedTargetingOption[]),
    );

const findByChannel = (
  partnerId: string,
  targetingType: string,
  channelId: string,
  negative: boolean | undefined,
) =>
  listAt(partnerId, targetingType).pipe(
    Effect.map((options) =>
      options.find(
        (option) =>
          option.channelDetails?.channelId === channelId &&
          (option.channelDetails?.negative === true) === (negative === true),
      ),
    ),
  );

export const PartnersTargetingTypesAssignedTargetingOptionProvider = () =>
  Provider.succeed(PartnersTargetingTypesAssignedTargetingOption, {
    stables: [
      "name",
      "partnerId",
      "targetingType",
      "assignedTargetingOptionId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousPartner = olds?.partnerId ?? output?.partnerId;
      if (previousPartner !== undefined && news.partnerId !== previousPartner) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType =
        olds?.targetingType ?? output?.targetingType ?? CHANNEL_TARGETING_TYPE;
      const nextType = news.targetingType ?? CHANNEL_TARGETING_TYPE;
      const previousChannel = olds?.channelDetails ?? output?.channelDetails;
      if (
        nextType !== previousType ||
        (previousChannel !== undefined &&
          !jsonEqual(news.channelDetails, previousChannel))
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId =
        olds?.assignedTargetingOptionId ?? output?.assignedTargetingOptionId;
      if (
        previousId !== undefined &&
        news.assignedTargetingOptionId !== undefined &&
        news.assignedTargetingOptionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const partnerId = olds?.partnerId ?? output?.partnerId ?? "";
      const targetingType =
        olds?.targetingType ?? output?.targetingType ?? CHANNEL_TARGETING_TYPE;
      let existing = yield* getById(
        partnerId,
        targetingType,
        olds?.assignedTargetingOptionId ?? output?.assignedTargetingOptionId,
      );
      if (
        existing === undefined &&
        partnerId &&
        olds?.channelDetails?.channelId
      ) {
        existing = yield* findByChannel(
          partnerId,
          targetingType,
          olds.channelDetails.channelId,
          olds.channelDetails.negative,
        );
      }
      if (existing === undefined) return undefined;
      return toAttrs(existing, partnerId, targetingType);
    }),

    list: () =>
      // Channel assignments have no labels or description to stamp, so
      // nuke uses engine state rather than scanning every partner CHANNEL
      // assignment (which would delete foreign targeting).
      Effect.succeed([]),

    reconcile: Effect.fn(function* ({ news, output }) {
      const partnerId = news.partnerId;
      const targetingType = news.targetingType ?? CHANNEL_TARGETING_TYPE;
      const channelId = news.channelDetails.channelId ?? "";
      const negative = news.channelDetails.negative ?? true;

      let current = yield* getById(
        partnerId,
        targetingType,
        news.assignedTargetingOptionId ?? output?.assignedTargetingOptionId,
      );
      if (current === undefined && channelId) {
        current = yield* findByChannel(
          partnerId,
          targetingType,
          channelId,
          negative,
        );
      }

      if (current === undefined) {
        const created = yield* dv
          .createPartnersTargetingTypesAssignedTargetingOptions({
            partnerId,
            targetingType,
            body: assignedBody({
              channelDetails: { channelId, negative },
            }),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              channelId
                ? findByChannel(partnerId, targetingType, channelId, negative)
                : Effect.succeed(undefined),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PartnersTargetingTypesAssignedTargetingOptionNotResolved(
          {
            assignedTargetingOptionId:
              news.assignedTargetingOptionId ??
              output?.assignedTargetingOptionId ??
              channelId,
          },
        );
      }

      return toAttrs(current, partnerId, targetingType);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        !output.partnerId ||
        !output.targetingType ||
        !output.assignedTargetingOptionId
      ) {
        return;
      }
      yield* dv
        .deletePartnersTargetingTypesAssignedTargetingOptions({
          partnerId: output.partnerId,
          targetingType: output.targetingType,
          assignedTargetingOptionId: output.assignedTargetingOptionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
