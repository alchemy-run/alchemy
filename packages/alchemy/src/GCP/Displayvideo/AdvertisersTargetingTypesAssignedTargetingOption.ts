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
  MAX_KEYWORD_LENGTH,
  ownedByAlchemy,
  toDisplayName,
} from "./ownership.ts";
import {
  assignedBody,
  detailsEqual,
  detailsFromOption,
  KEYWORD_TARGETING_TYPE,
  ownershipTextOf,
  parseAssignedName,
  type AssignedTargetingDetails,
} from "./targeting.ts";

export type AdvertisersTargetingTypesAssignedTargetingOptionProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the assignment.
   */
  advertiserId: string;
  /**
   * Targeting type. Advertiser assignments support `TARGETING_TYPE_CHANNEL`,
   * `TARGETING_TYPE_DIGITAL_CONTENT_LABEL_EXCLUSION`, `TARGETING_TYPE_OMID`,
   * `TARGETING_TYPE_SENSITIVE_CATEGORY_EXCLUSION`, and
   * `TARGETING_TYPE_KEYWORD`. Immutable.
   * @default "TARGETING_TYPE_KEYWORD"
   */
  targetingType?: string;
  /**
   * System-assigned option id. Omit on create; pass the observed id to
   * target an existing assignment.
   */
  assignedTargetingOptionId?: string;
  /**
   * Keyword targeting. Alchemy ownership is stamped into `keyword` when
   * `targetingType` is `TARGETING_TYPE_KEYWORD`.
   */
  keywordDetails?: AssignedTargetingDetails["keywordDetails"];
  /** Channel targeting. Advertiser-level channel options must be negative. */
  channelDetails?: AssignedTargetingDetails["channelDetails"];
  /** Digital content-label exclusion. */
  digitalContentLabelExclusionDetails?: AssignedTargetingDetails["digitalContentLabelExclusionDetails"];
  /** Sensitive-category exclusion. */
  sensitiveCategoryExclusionDetails?: AssignedTargetingDetails["sensitiveCategoryExclusionDetails"];
  /** Open Measurement inventory. */
  omidDetails?: AssignedTargetingDetails["omidDetails"];
};

export type AdvertisersTargetingTypesAssignedTargetingOption = Resource<
  "GCP.Displayvideo.AdvertisersTargetingTypesAssignedTargetingOption",
  AdvertisersTargetingTypesAssignedTargetingOptionProps,
  {
    /** Resource name `advertisers/{advertiser}/targetingTypes/{type}/assignedTargetingOptions/{id}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** Targeting type. */
    targetingType: string;
    /** System-assigned option id. */
    assignedTargetingOptionId: string;
    /** Alias for the option id when the targeting type supports one. */
    assignedTargetingOptionIdAlias: string | undefined;
    /** Inheritance status. */
    inheritance: string | undefined;
    /** Keyword targeting with ownership stripped from `keyword`. */
    keywordDetails: AssignedTargetingDetails["keywordDetails"];
    /** Channel targeting. */
    channelDetails: AssignedTargetingDetails["channelDetails"];
    /** Digital content-label exclusion. */
    digitalContentLabelExclusionDetails: AssignedTargetingDetails["digitalContentLabelExclusionDetails"];
    /** Sensitive-category exclusion. */
    sensitiveCategoryExclusionDetails: AssignedTargetingDetails["sensitiveCategoryExclusionDetails"];
    /** Open Measurement inventory. */
    omidDetails: AssignedTargetingDetails["omidDetails"];
  },
  never,
  Providers
>;

/**
 * A targeting option assigned to a Display and Video 360 advertiser.
 *
 * Assigned targeting options have no labels field — Alchemy stamps
 * ownership into the keyword when `targetingType` is
 * `TARGETING_TYPE_KEYWORD`. Parent advertiser, targeting type, and
 * details are identity; changing them replaces the assignment.
 *
 * ### Creating an Assigned Targeting Option
 * **Example:** Negative keyword on an advertiser
 * ```typescript
 * const option = yield* GCP.Displayvideo.AdvertisersTargetingTypesAssignedTargetingOption("Exclude", {
 *   advertiserId: advertiser.advertiserId,
 *   targetingType: "TARGETING_TYPE_KEYWORD",
 *   keywordDetails: { keyword: "competitor", negative: true },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersTargetingTypesAssignedTargetingOption =
  Resource<AdvertisersTargetingTypesAssignedTargetingOption>(
    "GCP.Displayvideo.AdvertisersTargetingTypesAssignedTargetingOption",
  );

export class AdvertisersTargetingTypesAssignedTargetingOptionNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersTargetingTypesAssignedTargetingOptionNotResolved",
)<{
  assignedTargetingOptionId: string;
}> {}

const detailsOf = (
  props: AdvertisersTargetingTypesAssignedTargetingOptionProps,
): AssignedTargetingDetails => ({
  keywordDetails: props.keywordDetails,
  channelDetails: props.channelDetails,
  digitalContentLabelExclusionDetails:
    props.digitalContentLabelExclusionDetails,
  sensitiveCategoryExclusionDetails: props.sensitiveCategoryExclusionDetails,
  omidDetails: props.omidDetails,
});

const toAttrs = (
  option: dv.AssignedTargetingOption,
  advertiserId: string,
  targetingType: string,
) => {
  const parsed = parseAssignedName(option.name ?? "");
  const details = detailsFromOption(option);
  return {
    name: option.name ?? "",
    advertiserId: parsed.advertiserId || advertiserId,
    targetingType:
      option.targetingType ?? (parsed.targetingType || targetingType),
    assignedTargetingOptionId:
      option.assignedTargetingOptionId ?? parsed.assignedTargetingOptionId,
    assignedTargetingOptionIdAlias: option.assignedTargetingOptionIdAlias,
    inheritance: option.inheritance,
    keywordDetails: details.keywordDetails,
    channelDetails: details.channelDetails,
    digitalContentLabelExclusionDetails:
      details.digitalContentLabelExclusionDetails,
    sensitiveCategoryExclusionDetails:
      details.sensitiveCategoryExclusionDetails,
    omidDetails: details.omidDetails,
  };
};

const getById = (
  advertiserId: string,
  targetingType: string,
  assignedTargetingOptionId: string | undefined,
) =>
  !assignedTargetingOptionId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersTargetingTypesAssignedTargetingOptions({
          advertiserId,
          targetingType,
          assignedTargetingOptionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string, targetingType: string) =>
  dv.listAdvertisersTargetingTypesAssignedTargetingOptions
    .pages({ advertiserId, targetingType, pageSize: 200 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.assignedTargetingOptions ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dv.AssignedTargetingOption[]),
    );

const findOwned = (
  advertiserId: string,
  targetingType: string,
  displayName: string,
) =>
  listAt(advertiserId, targetingType).pipe(
    Effect.map((options) =>
      options.find(
        (option) =>
          option.keywordDetails?.keyword === displayName ||
          option.name === displayName,
      ),
    ),
  );

export const AdvertisersTargetingTypesAssignedTargetingOptionProvider = () =>
  Provider.succeed(AdvertisersTargetingTypesAssignedTargetingOption, {
    stables: [
      "name",
      "advertiserId",
      "targetingType",
      "assignedTargetingOptionId",
    ],

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
        olds?.targetingType ?? output?.targetingType ?? KEYWORD_TARGETING_TYPE;
      const nextType = news.targetingType ?? KEYWORD_TARGETING_TYPE;
      const previousDetails = {
        keywordDetails: olds?.keywordDetails ?? output?.keywordDetails,
        channelDetails: olds?.channelDetails ?? output?.channelDetails,
        digitalContentLabelExclusionDetails:
          olds?.digitalContentLabelExclusionDetails ??
          output?.digitalContentLabelExclusionDetails,
        sensitiveCategoryExclusionDetails:
          olds?.sensitiveCategoryExclusionDetails ??
          output?.sensitiveCategoryExclusionDetails,
        omidDetails: olds?.omidDetails ?? output?.omidDetails,
      };
      const nextDetails = detailsOf({
        ...news,
        keywordDetails: news.keywordDetails ?? previousDetails.keywordDetails,
        channelDetails: news.channelDetails ?? previousDetails.channelDetails,
        digitalContentLabelExclusionDetails:
          news.digitalContentLabelExclusionDetails ??
          previousDetails.digitalContentLabelExclusionDetails,
        sensitiveCategoryExclusionDetails:
          news.sensitiveCategoryExclusionDetails ??
          previousDetails.sensitiveCategoryExclusionDetails,
        omidDetails: news.omidDetails ?? previousDetails.omidDetails,
      });
      if (
        nextType !== previousType ||
        (output !== undefined && !detailsEqual(nextDetails, previousDetails))
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

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      const targetingType =
        olds?.targetingType ?? output?.targetingType ?? KEYWORD_TARGETING_TYPE;
      let existing = yield* getById(
        advertiserId,
        targetingType,
        olds?.assignedTargetingOptionId ?? output?.assignedTargetingOptionId,
      );
      if (existing === undefined && advertiserId) {
        const ownership = yield* createInternalLabels(id);
        const keyword = encodeOwnershipLine(
          ownership,
          olds?.keywordDetails?.keyword,
          MAX_KEYWORD_LENGTH,
        );
        existing = yield* findOwned(advertiserId, targetingType, keyword);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, advertiserId, targetingType);
      const owned =
        targetingType === KEYWORD_TARGETING_TYPE
          ? yield* ownedByAlchemy(id, ownershipTextOf(existing))
          : true;
      return owned ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const advertiserIds = yield* listAccessibleAdvertiserIds();
        const pages = yield* Effect.forEach(
          advertiserIds,
          (advertiserId) => listAt(advertiserId, KEYWORD_TARGETING_TYPE),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((option) => hasOwnershipMarker(ownershipTextOf(option)))
          .map((option) =>
            toAttrs(
              option,
              parseAssignedName(option.name ?? "").advertiserId,
              KEYWORD_TARGETING_TYPE,
            ),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const advertiserId = news.advertiserId;
      const targetingType = news.targetingType ?? KEYWORD_TARGETING_TYPE;
      const ownership = yield* createInternalLabels(id);
      const userKeyword = yield* toDisplayName(
        id,
        news.keywordDetails?.keyword,
        output?.keywordDetails?.keyword,
      );
      const stampedKeyword =
        targetingType === KEYWORD_TARGETING_TYPE
          ? encodeOwnershipLine(ownership, userKeyword, MAX_KEYWORD_LENGTH)
          : undefined;
      const details: AssignedTargetingDetails = {
        ...detailsOf(news),
        keywordDetails:
          targetingType === KEYWORD_TARGETING_TYPE
            ? {
                keyword: userKeyword,
                negative: news.keywordDetails?.negative ?? true,
              }
            : news.keywordDetails,
      };

      let current = yield* getById(
        advertiserId,
        targetingType,
        news.assignedTargetingOptionId ?? output?.assignedTargetingOptionId,
      );
      if (current === undefined && stampedKeyword) {
        current = yield* findOwned(advertiserId, targetingType, stampedKeyword);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersTargetingTypesAssignedTargetingOptions({
            advertiserId,
            targetingType,
            body: assignedBody(details, stampedKeyword),
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              stampedKeyword
                ? findOwned(advertiserId, targetingType, stampedKeyword)
                : Effect.succeed(undefined),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AdvertisersTargetingTypesAssignedTargetingOptionNotResolved(
          {
            assignedTargetingOptionId:
              news.assignedTargetingOptionId ??
              output?.assignedTargetingOptionId ??
              userKeyword,
          },
        );
      }

      return toAttrs(current, advertiserId, targetingType);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (
        !output.advertiserId ||
        !output.targetingType ||
        !output.assignedTargetingOptionId
      ) {
        return;
      }
      yield* dv
        .deleteAdvertisersTargetingTypesAssignedTargetingOptions({
          advertiserId: output.advertiserId,
          targetingType: output.targetingType,
          assignedTargetingOptionId: output.assignedTargetingOptionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
