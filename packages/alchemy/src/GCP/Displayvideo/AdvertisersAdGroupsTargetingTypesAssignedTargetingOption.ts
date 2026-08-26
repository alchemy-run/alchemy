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
  ignoreList,
  jsonEqual,
  listOwnedAdvertiserIds,
  ownedByAlchemy,
  parseOwnership,
} from "./ownership.ts";

const LIST_TARGETING_TYPES = [
  "TARGETING_TYPE_KEYWORD",
  "TARGETING_TYPE_GENDER",
  "TARGETING_TYPE_AGE_RANGE",
  "TARGETING_TYPE_PARENTAL_STATUS",
  "TARGETING_TYPE_HOUSEHOLD_INCOME",
  "TARGETING_TYPE_LANGUAGE",
  "TARGETING_TYPE_URL",
  "TARGETING_TYPE_APP",
  "TARGETING_TYPE_CATEGORY",
] as const;

export type AdvertisersAdGroupsTargetingTypesAssignedTargetingOptionProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the
   * assignment.
   */
  advertiserId: string;
  /**
   * Parent ad group id. Immutable — changing it replaces the
   * assignment.
   */
  adGroupId: string;
  /**
   * Targeting type in the URL, for example `TARGETING_TYPE_KEYWORD`.
   * Immutable — changing it replaces the assignment.
   */
  targetingType: string;
  /**
   * System-assigned option id. Omit on create; pass the observed id to
   * look up an existing assignment. Assigned targeting options are
   * identity-only — changing details replaces the assignment.
   */
  assignedTargetingOptionId?: string;
  /** Keyword details when `targetingType` is `TARGETING_TYPE_KEYWORD`. */
  keywordDetails?: dv.KeywordAssignedTargetingOptionDetails;
  /** Gender details when `targetingType` is `TARGETING_TYPE_GENDER`. */
  genderDetails?: dv.GenderAssignedTargetingOptionDetails;
  /** Age-range details. */
  ageRangeDetails?: dv.AgeRangeAssignedTargetingOptionDetails;
  /** Parental-status details. */
  parentalStatusDetails?: dv.ParentalStatusAssignedTargetingOptionDetails;
  /** Household-income details. */
  householdIncomeDetails?: dv.HouseholdIncomeAssignedTargetingOptionDetails;
  /** Language details. */
  languageDetails?: dv.LanguageAssignedTargetingOptionDetails;
  /** URL details. */
  urlDetails?: dv.UrlAssignedTargetingOptionDetails;
  /** App details. */
  appDetails?: dv.AppAssignedTargetingOptionDetails;
  /** Category details. */
  categoryDetails?: dv.CategoryAssignedTargetingOptionDetails;
  /** Audience-group details. */
  audienceGroupDetails?: dv.AudienceGroupAssignedTargetingOptionDetails;
  /** Geo-region details. */
  geoRegionDetails?: dv.GeoRegionAssignedTargetingOptionDetails;
  /** YouTube channel details. */
  youtubeChannelDetails?: dv.YoutubeChannelAssignedTargetingOptionDetails;
  /** YouTube video details. */
  youtubeVideoDetails?: dv.YoutubeVideoAssignedTargetingOptionDetails;
};

export type AdvertisersAdGroupsTargetingTypesAssignedTargetingOption = Resource<
  "GCP.Displayvideo.AdvertisersAdGroupsTargetingTypesAssignedTargetingOption",
  AdvertisersAdGroupsTargetingTypesAssignedTargetingOptionProps,
  {
    /** Resource name of the assigned targeting option. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** Parent ad group id. */
    adGroupId: string;
    /** Targeting type. */
    targetingType: string;
    /** System-assigned option id. */
    assignedTargetingOptionId: string;
    /** Optional id alias for some targeting types. */
    assignedTargetingOptionIdAlias: string | undefined;
    /** Inheritance status. */
    inheritance: string | undefined;
    /** Keyword details. */
    keywordDetails: dv.KeywordAssignedTargetingOptionDetails | undefined;
    /** Gender details. */
    genderDetails: dv.GenderAssignedTargetingOptionDetails | undefined;
    /** Age-range details. */
    ageRangeDetails: dv.AgeRangeAssignedTargetingOptionDetails | undefined;
    /** Parental-status details. */
    parentalStatusDetails:
      | dv.ParentalStatusAssignedTargetingOptionDetails
      | undefined;
    /** Household-income details. */
    householdIncomeDetails:
      | dv.HouseholdIncomeAssignedTargetingOptionDetails
      | undefined;
    /** Language details. */
    languageDetails: dv.LanguageAssignedTargetingOptionDetails | undefined;
    /** URL details. */
    urlDetails: dv.UrlAssignedTargetingOptionDetails | undefined;
    /** App details. */
    appDetails: dv.AppAssignedTargetingOptionDetails | undefined;
    /** Category details. */
    categoryDetails: dv.CategoryAssignedTargetingOptionDetails | undefined;
  },
  never,
  Providers
>;

/**
 * A targeting option assigned to a Demand Gen ad group.
 *
 * Assigned targeting options have no labels or display name. Alchemy
 * stamps ownership into keyword text when `targetingType` is
 * `TARGETING_TYPE_KEYWORD`; other types are listed from alchemy-owned
 * parent ad groups. There is no update API — changing details replaces
 * the assignment. Create currently supports Demand Gen ad groups only.
 *
 * ### Creating an Assigned Targeting Option
 * **Example:** Negative keyword
 * ```typescript
 * const option = yield* GCP.Displayvideo.AdvertisersAdGroupsTargetingTypesAssignedTargetingOption(
 *   "Exclude",
 *   {
 *     advertiserId: adGroup.advertiserId,
 *     adGroupId: adGroup.adGroupId,
 *     targetingType: "TARGETING_TYPE_KEYWORD",
 *     keywordDetails: { keyword: "competitor", negative: true },
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersAdGroupsTargetingTypesAssignedTargetingOption =
  Resource<AdvertisersAdGroupsTargetingTypesAssignedTargetingOption>(
    "GCP.Displayvideo.AdvertisersAdGroupsTargetingTypesAssignedTargetingOption",
  );

export class AdvertisersAdGroupsTargetingTypesAssignedTargetingOptionNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersAdGroupsTargetingTypesAssignedTargetingOptionNotResolved",
)<{
  assignedTargetingOptionId: string;
}> {}

const detailsOf = (
  news: AdvertisersAdGroupsTargetingTypesAssignedTargetingOptionProps,
) => ({
  keywordDetails: news.keywordDetails,
  genderDetails: news.genderDetails,
  ageRangeDetails: news.ageRangeDetails,
  parentalStatusDetails: news.parentalStatusDetails,
  householdIncomeDetails: news.householdIncomeDetails,
  languageDetails: news.languageDetails,
  urlDetails: news.urlDetails,
  appDetails: news.appDetails,
  categoryDetails: news.categoryDetails,
  audienceGroupDetails: news.audienceGroupDetails,
  geoRegionDetails: news.geoRegionDetails,
  youtubeChannelDetails: news.youtubeChannelDetails,
  youtubeVideoDetails: news.youtubeVideoDetails,
});

const toAttrs = (
  option: dv.AssignedTargetingOption,
  advertiserId: string,
  adGroupId: string,
) => ({
  name: option.name ?? "",
  advertiserId,
  adGroupId,
  targetingType: option.targetingType ?? "",
  assignedTargetingOptionId: option.assignedTargetingOptionId ?? "",
  assignedTargetingOptionIdAlias: option.assignedTargetingOptionIdAlias,
  inheritance: option.inheritance,
  keywordDetails: option.keywordDetails
    ? {
        ...option.keywordDetails,
        keyword: parseOwnership(option.keywordDetails.keyword).text,
      }
    : undefined,
  genderDetails: option.genderDetails,
  ageRangeDetails: option.ageRangeDetails,
  parentalStatusDetails: option.parentalStatusDetails,
  householdIncomeDetails: option.householdIncomeDetails,
  languageDetails: option.languageDetails,
  urlDetails: option.urlDetails,
  appDetails: option.appDetails,
  categoryDetails: option.categoryDetails,
});

const ownershipText = (option: dv.AssignedTargetingOption) =>
  option.keywordDetails?.keyword;

const getById = (
  advertiserId: string,
  adGroupId: string,
  targetingType: string,
  assignedTargetingOptionId: string | undefined,
) =>
  !assignedTargetingOptionId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersAdGroupsTargetingTypesAssignedTargetingOptions({
          advertiserId,
          adGroupId,
          targetingType,
          assignedTargetingOptionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (
  advertiserId: string,
  adGroupId: string,
  targetingType: string,
) =>
  dv.listAdvertisersAdGroupsTargetingTypesAssignedTargetingOptions
    .pages({ advertiserId, adGroupId, targetingType, pageSize: 1000 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.assignedTargetingOptions ?? []),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      ignoreList([] as dv.AssignedTargetingOption[]),
    );

const listAdGroups = (advertiserId: string) =>
  dv.listAdvertisersAdGroups.pages({ advertiserId, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.adGroups ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.AdGroup[]),
  );

const findMatching = (
  advertiserId: string,
  adGroupId: string,
  targetingType: string,
  desired: ReturnType<typeof detailsOf>,
) =>
  listAt(advertiserId, adGroupId, targetingType).pipe(
    Effect.map((options) =>
      options.find((option) => jsonEqual(detailsOf(option as never), desired)),
    ),
  );

export const AdvertisersAdGroupsTargetingTypesAssignedTargetingOptionProvider =
  () =>
    Provider.succeed(AdvertisersAdGroupsTargetingTypesAssignedTargetingOption, {
      stables: [
        "name",
        "advertiserId",
        "adGroupId",
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
          return { action: "replace" as const, deleteFirst: true };
        }
        const previousGroup = olds?.adGroupId ?? output?.adGroupId;
        if (previousGroup !== undefined && news.adGroupId !== previousGroup) {
          return { action: "replace" as const, deleteFirst: true };
        }
        const previousType = olds?.targetingType ?? output?.targetingType;
        if (previousType !== undefined && news.targetingType !== previousType) {
          return { action: "replace" as const, deleteFirst: true };
        }
        if (
          olds !== undefined &&
          !jsonEqual(detailsOf(olds), detailsOf(news))
        ) {
          return { action: "replace" as const, deleteFirst: true };
        }
        return undefined;
      }),

      read: Effect.fn(function* ({ id, olds, output }) {
        const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
        const adGroupId = olds?.adGroupId ?? output?.adGroupId ?? "";
        const targetingType =
          olds?.targetingType ?? output?.targetingType ?? "";
        let existing = yield* getById(
          advertiserId,
          adGroupId,
          targetingType,
          olds?.assignedTargetingOptionId ?? output?.assignedTargetingOptionId,
        );
        if (
          existing === undefined &&
          advertiserId &&
          adGroupId &&
          targetingType
        ) {
          existing = yield* findMatching(
            advertiserId,
            adGroupId,
            targetingType,
            detailsOf({
              ...olds,
              advertiserId,
              adGroupId,
              targetingType,
            }),
          );
        }
        if (existing === undefined) return undefined;
        const attrs = toAttrs(existing, advertiserId, adGroupId);
        const owned =
          (yield* ownedByAlchemy(id, ownershipText(existing))) ||
          output !== undefined;
        return owned ? attrs : Unowned(attrs);
      }),

      list: () =>
        Effect.gen(function* () {
          const advertiserIds = yield* listOwnedAdvertiserIds();
          const rows: ReturnType<typeof toAttrs>[] = [];
          for (const advertiserId of advertiserIds) {
            const adGroups = yield* listAdGroups(advertiserId);
            const ownedGroups = adGroups.filter((adGroup) =>
              (adGroup.displayName ?? "").startsWith("[alchemy "),
            );
            for (const adGroup of ownedGroups) {
              const adGroupId = adGroup.adGroupId ?? "";
              if (!adGroupId) continue;
              const options = yield* Effect.forEach(
                LIST_TARGETING_TYPES,
                (targetingType) =>
                  listAt(advertiserId, adGroupId, targetingType).pipe(
                    Effect.map((listed) =>
                      listed.map((option) =>
                        toAttrs(option, advertiserId, adGroupId),
                      ),
                    ),
                  ),
                { concurrency: 4 },
              );
              rows.push(...options.flat());
            }
          }
          return rows;
        }),

      reconcile: Effect.fn(function* ({ id, news, output }) {
        const advertiserId = news.advertiserId;
        const adGroupId = news.adGroupId;
        const targetingType = news.targetingType;
        const ownership = yield* createInternalLabels(id);
        const keywordDetails =
          news.keywordDetails === undefined
            ? undefined
            : {
                ...news.keywordDetails,
                keyword: news.keywordDetails.keyword
                  ? encodeOwnershipLine(
                      ownership,
                      news.keywordDetails.keyword,
                      80,
                    )
                  : news.keywordDetails.keyword,
              };
        const desired = {
          ...detailsOf(news),
          keywordDetails,
        };

        let current = yield* getById(
          advertiserId,
          adGroupId,
          targetingType,
          news.assignedTargetingOptionId ?? output?.assignedTargetingOptionId,
        );
        if (current === undefined) {
          current = yield* findMatching(
            advertiserId,
            adGroupId,
            targetingType,
            desired,
          );
        }

        if (current === undefined) {
          const created = yield* dv
            .createAdvertisersAdGroupsTargetingTypesAssignedTargetingOptions({
              advertiserId,
              adGroupId,
              targetingType,
              body: {
                targetingType,
                ...desired,
              },
            })
            .pipe(
              Effect.catchTag("Conflict", () =>
                findMatching(advertiserId, adGroupId, targetingType, desired),
              ),
            );
          current = created ?? undefined;
        }

        if (current === undefined) {
          return yield* new AdvertisersAdGroupsTargetingTypesAssignedTargetingOptionNotResolved(
            {
              assignedTargetingOptionId:
                news.assignedTargetingOptionId ??
                output?.assignedTargetingOptionId ??
                targetingType,
            },
          );
        }

        return toAttrs(current, advertiserId, adGroupId);
      }),

      delete: Effect.fn(function* ({ output }) {
        if (
          !output.advertiserId ||
          !output.adGroupId ||
          !output.targetingType ||
          !output.assignedTargetingOptionId
        ) {
          return;
        }
        yield* dv
          .deleteAdvertisersAdGroupsTargetingTypesAssignedTargetingOptions({
            advertiserId: output.advertiserId,
            adGroupId: output.adGroupId,
            targetingType: output.targetingType,
            assignedTargetingOptionId: output.assignedTargetingOptionId,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    });
