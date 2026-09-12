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
  listLineItems,
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

export type AdvertisersLineItemsTargetingTypesAssignedTargetingOptionProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the assignment.
   */
  advertiserId: string;
  /**
   * Parent line item id. Immutable — changing it replaces the assignment.
   */
  lineItemId: string;
  /**
   * Targeting type. Immutable.
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
  /** Channel targeting. */
  channelDetails?: AssignedTargetingDetails["channelDetails"];
  /** URL targeting. */
  urlDetails?: AssignedTargetingDetails["urlDetails"];
  /** Gender targeting. */
  genderDetails?: AssignedTargetingDetails["genderDetails"];
  /** Environment targeting. */
  environmentDetails?: AssignedTargetingDetails["environmentDetails"];
  /** Device-type targeting. */
  deviceTypeDetails?: AssignedTargetingDetails["deviceTypeDetails"];
  /** Viewability targeting. */
  viewabilityDetails?: AssignedTargetingDetails["viewabilityDetails"];
  /** Age-range targeting. */
  ageRangeDetails?: AssignedTargetingDetails["ageRangeDetails"];
  /** App targeting. */
  appDetails?: AssignedTargetingDetails["appDetails"];
  /** Inventory source group targeting. */
  inventorySourceGroupDetails?: AssignedTargetingDetails["inventorySourceGroupDetails"];
  /** Negative keyword list targeting. */
  negativeKeywordListDetails?: AssignedTargetingDetails["negativeKeywordListDetails"];
  /** Digital content-label exclusion. */
  digitalContentLabelExclusionDetails?: AssignedTargetingDetails["digitalContentLabelExclusionDetails"];
  /** Sensitive-category exclusion. */
  sensitiveCategoryExclusionDetails?: AssignedTargetingDetails["sensitiveCategoryExclusionDetails"];
  /** Open Measurement inventory. */
  omidDetails?: AssignedTargetingDetails["omidDetails"];
};

export type AdvertisersLineItemsTargetingTypesAssignedTargetingOption =
  Resource<
    "GCP.Displayvideo.AdvertisersLineItemsTargetingTypesAssignedTargetingOption",
    AdvertisersLineItemsTargetingTypesAssignedTargetingOptionProps,
    {
      /** Resource name `advertisers/{advertiser}/lineItems/{lineItem}/targetingTypes/{type}/assignedTargetingOptions/{id}`. */
      name: string;
      /** Parent advertiser id. */
      advertiserId: string;
      /** Parent line item id. */
      lineItemId: string;
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
      /** URL targeting. */
      urlDetails: AssignedTargetingDetails["urlDetails"];
      /** Gender targeting. */
      genderDetails: AssignedTargetingDetails["genderDetails"];
      /** Environment targeting. */
      environmentDetails: AssignedTargetingDetails["environmentDetails"];
      /** Device-type targeting. */
      deviceTypeDetails: AssignedTargetingDetails["deviceTypeDetails"];
      /** Viewability targeting. */
      viewabilityDetails: AssignedTargetingDetails["viewabilityDetails"];
      /** Age-range targeting. */
      ageRangeDetails: AssignedTargetingDetails["ageRangeDetails"];
      /** App targeting. */
      appDetails: AssignedTargetingDetails["appDetails"];
      /** Inventory source group targeting. */
      inventorySourceGroupDetails: AssignedTargetingDetails["inventorySourceGroupDetails"];
      /** Negative keyword list targeting. */
      negativeKeywordListDetails: AssignedTargetingDetails["negativeKeywordListDetails"];
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
 * A targeting option assigned to a Display and Video 360 line item.
 *
 * Assigned targeting options have no labels field — Alchemy stamps
 * ownership into the keyword when `targetingType` is
 * `TARGETING_TYPE_KEYWORD`. Parent ids, targeting type, and details are
 * identity; changing them replaces the assignment. YouTube and Partners
 * line items cannot be updated through this API.
 *
 * ### Creating a Line Item Assigned Targeting Option
 * **Example:** Negative keyword on a line item
 * ```typescript
 * const option = yield* GCP.Displayvideo.AdvertisersLineItemsTargetingTypesAssignedTargetingOption("Exclude", {
 *   advertiserId: advertiser.advertiserId,
 *   lineItemId: lineItem.lineItemId,
 *   targetingType: "TARGETING_TYPE_KEYWORD",
 *   keywordDetails: { keyword: "competitor", negative: true },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersLineItemsTargetingTypesAssignedTargetingOption =
  Resource<AdvertisersLineItemsTargetingTypesAssignedTargetingOption>(
    "GCP.Displayvideo.AdvertisersLineItemsTargetingTypesAssignedTargetingOption",
  );

export class AdvertisersLineItemsTargetingTypesAssignedTargetingOptionNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersLineItemsTargetingTypesAssignedTargetingOptionNotResolved",
)<{
  assignedTargetingOptionId: string;
}> {}

const detailsOf = (
  props: AdvertisersLineItemsTargetingTypesAssignedTargetingOptionProps,
): AssignedTargetingDetails => ({
  keywordDetails: props.keywordDetails,
  channelDetails: props.channelDetails,
  urlDetails: props.urlDetails,
  genderDetails: props.genderDetails,
  environmentDetails: props.environmentDetails,
  deviceTypeDetails: props.deviceTypeDetails,
  viewabilityDetails: props.viewabilityDetails,
  ageRangeDetails: props.ageRangeDetails,
  appDetails: props.appDetails,
  inventorySourceGroupDetails: props.inventorySourceGroupDetails,
  negativeKeywordListDetails: props.negativeKeywordListDetails,
  digitalContentLabelExclusionDetails:
    props.digitalContentLabelExclusionDetails,
  sensitiveCategoryExclusionDetails: props.sensitiveCategoryExclusionDetails,
  omidDetails: props.omidDetails,
});

const toAttrs = (
  option: dv.AssignedTargetingOption,
  advertiserId: string,
  lineItemId: string,
  targetingType: string,
) => {
  const parsed = parseAssignedName(option.name ?? "");
  const details = detailsFromOption(option);
  return {
    name: option.name ?? "",
    advertiserId: parsed.advertiserId || advertiserId,
    lineItemId: parsed.lineItemId || lineItemId,
    targetingType:
      option.targetingType ?? (parsed.targetingType || targetingType),
    assignedTargetingOptionId:
      option.assignedTargetingOptionId ?? parsed.assignedTargetingOptionId,
    assignedTargetingOptionIdAlias: option.assignedTargetingOptionIdAlias,
    inheritance:
      option.inheritance === undefined ? undefined : `${option.inheritance}`,
    keywordDetails: details.keywordDetails,
    channelDetails: details.channelDetails,
    urlDetails: details.urlDetails,
    genderDetails: details.genderDetails,
    environmentDetails: details.environmentDetails,
    deviceTypeDetails: details.deviceTypeDetails,
    viewabilityDetails: details.viewabilityDetails,
    ageRangeDetails: details.ageRangeDetails,
    appDetails: details.appDetails,
    inventorySourceGroupDetails: details.inventorySourceGroupDetails,
    negativeKeywordListDetails: details.negativeKeywordListDetails,
    digitalContentLabelExclusionDetails:
      details.digitalContentLabelExclusionDetails,
    sensitiveCategoryExclusionDetails:
      details.sensitiveCategoryExclusionDetails,
    omidDetails: details.omidDetails,
  };
};

const getById = (
  advertiserId: string,
  lineItemId: string,
  targetingType: string,
  assignedTargetingOptionId: string | undefined,
) =>
  !assignedTargetingOptionId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersLineItemsTargetingTypesAssignedTargetingOptions({
          advertiserId,
          lineItemId,
          targetingType,
          assignedTargetingOptionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (
  advertiserId: string,
  lineItemId: string,
  targetingType: string,
) =>
  dv.listAdvertisersLineItemsTargetingTypesAssignedTargetingOptions
    .pages({ advertiserId, lineItemId, targetingType, pageSize: 200 })
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
  lineItemId: string,
  targetingType: string,
  displayName: string,
) =>
  listAt(advertiserId, lineItemId, targetingType).pipe(
    Effect.map((options) =>
      options.find((option) => option.keywordDetails?.keyword === displayName),
    ),
  );

export const AdvertisersLineItemsTargetingTypesAssignedTargetingOptionProvider =
  () =>
    Provider.succeed(
      AdvertisersLineItemsTargetingTypesAssignedTargetingOption,
      {
        stables: [
          "name",
          "advertiserId",
          "lineItemId",
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
          const previousLineItem = olds?.lineItemId ?? output?.lineItemId;
          if (
            previousLineItem !== undefined &&
            news.lineItemId !== previousLineItem
          ) {
            return { action: "replace" as const, deleteFirst: false };
          }
          const previousType =
            olds?.targetingType ??
            output?.targetingType ??
            KEYWORD_TARGETING_TYPE;
          const nextType = news.targetingType ?? KEYWORD_TARGETING_TYPE;
          const previousDetails = detailsOf({
            advertiserId: news.advertiserId,
            lineItemId: news.lineItemId,
            keywordDetails: olds?.keywordDetails ?? output?.keywordDetails,
            channelDetails: olds?.channelDetails ?? output?.channelDetails,
            urlDetails: olds?.urlDetails ?? output?.urlDetails,
            genderDetails: olds?.genderDetails ?? output?.genderDetails,
            environmentDetails:
              olds?.environmentDetails ?? output?.environmentDetails,
            deviceTypeDetails:
              olds?.deviceTypeDetails ?? output?.deviceTypeDetails,
            viewabilityDetails:
              olds?.viewabilityDetails ?? output?.viewabilityDetails,
            ageRangeDetails: olds?.ageRangeDetails ?? output?.ageRangeDetails,
            appDetails: olds?.appDetails ?? output?.appDetails,
            inventorySourceGroupDetails:
              olds?.inventorySourceGroupDetails ??
              output?.inventorySourceGroupDetails,
            negativeKeywordListDetails:
              olds?.negativeKeywordListDetails ??
              output?.negativeKeywordListDetails,
            digitalContentLabelExclusionDetails:
              olds?.digitalContentLabelExclusionDetails ??
              output?.digitalContentLabelExclusionDetails,
            sensitiveCategoryExclusionDetails:
              olds?.sensitiveCategoryExclusionDetails ??
              output?.sensitiveCategoryExclusionDetails,
            omidDetails: olds?.omidDetails ?? output?.omidDetails,
          });
          const nextDetails = detailsOf({
            ...news,
            keywordDetails:
              news.keywordDetails ?? previousDetails.keywordDetails,
            channelDetails:
              news.channelDetails ?? previousDetails.channelDetails,
            urlDetails: news.urlDetails ?? previousDetails.urlDetails,
            genderDetails: news.genderDetails ?? previousDetails.genderDetails,
            environmentDetails:
              news.environmentDetails ?? previousDetails.environmentDetails,
            deviceTypeDetails:
              news.deviceTypeDetails ?? previousDetails.deviceTypeDetails,
            viewabilityDetails:
              news.viewabilityDetails ?? previousDetails.viewabilityDetails,
            ageRangeDetails:
              news.ageRangeDetails ?? previousDetails.ageRangeDetails,
            appDetails: news.appDetails ?? previousDetails.appDetails,
            inventorySourceGroupDetails:
              news.inventorySourceGroupDetails ??
              previousDetails.inventorySourceGroupDetails,
            negativeKeywordListDetails:
              news.negativeKeywordListDetails ??
              previousDetails.negativeKeywordListDetails,
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
            (output !== undefined &&
              !detailsEqual(nextDetails, previousDetails))
          ) {
            return { action: "replace" as const, deleteFirst: true };
          }
          const previousId =
            olds?.assignedTargetingOptionId ??
            output?.assignedTargetingOptionId;
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
          const lineItemId = olds?.lineItemId ?? output?.lineItemId ?? "";
          const targetingType =
            olds?.targetingType ??
            output?.targetingType ??
            KEYWORD_TARGETING_TYPE;
          let existing = yield* getById(
            advertiserId,
            lineItemId,
            targetingType,
            olds?.assignedTargetingOptionId ??
              output?.assignedTargetingOptionId,
          );
          if (existing === undefined && advertiserId && lineItemId) {
            const ownership = yield* createInternalLabels(id);
            const keyword = encodeOwnershipLine(
              ownership,
              olds?.keywordDetails?.keyword,
              MAX_KEYWORD_LENGTH,
            );
            existing = yield* findOwned(
              advertiserId,
              lineItemId,
              targetingType,
              keyword,
            );
          }
          if (existing === undefined) return undefined;
          const attrs = toAttrs(
            existing,
            advertiserId,
            lineItemId,
            targetingType,
          );
          const owned =
            targetingType === KEYWORD_TARGETING_TYPE
              ? yield* ownedByAlchemy(id, ownershipTextOf(existing))
              : true;
          return owned ? attrs : Unowned(attrs);
        }),

        list: () =>
          Effect.gen(function* () {
            const advertiserIds = yield* listAccessibleAdvertiserIds();
            const attrs: ReturnType<typeof toAttrs>[] = [];
            for (const advertiserId of advertiserIds) {
              const lineItems = yield* listLineItems(advertiserId);
              const pages = yield* Effect.forEach(
                lineItems,
                (lineItem) =>
                  lineItem.lineItemId
                    ? listAt(
                        advertiserId,
                        lineItem.lineItemId,
                        KEYWORD_TARGETING_TYPE,
                      )
                    : Effect.succeed([] as dv.AssignedTargetingOption[]),
                { concurrency: 4 },
              );
              for (let i = 0; i < pages.length; i++) {
                const lineItemId = lineItems[i]?.lineItemId ?? "";
                for (const option of pages[i] ?? []) {
                  if (!hasOwnershipMarker(ownershipTextOf(option))) continue;
                  attrs.push(
                    toAttrs(
                      option,
                      advertiserId,
                      lineItemId,
                      KEYWORD_TARGETING_TYPE,
                    ),
                  );
                }
              }
            }
            return attrs;
          }),

        reconcile: Effect.fn(function* ({ id, news, output }) {
          const advertiserId = news.advertiserId;
          const lineItemId = news.lineItemId;
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
            lineItemId,
            targetingType,
            news.assignedTargetingOptionId ?? output?.assignedTargetingOptionId,
          );
          if (current === undefined && stampedKeyword) {
            current = yield* findOwned(
              advertiserId,
              lineItemId,
              targetingType,
              stampedKeyword,
            );
          }

          if (current === undefined) {
            const created = yield* dv
              .createAdvertisersLineItemsTargetingTypesAssignedTargetingOptions(
                {
                  advertiserId,
                  lineItemId,
                  targetingType,
                  body: assignedBody(details, stampedKeyword),
                },
              )
              .pipe(
                Effect.catchTag("Conflict", () =>
                  stampedKeyword
                    ? findOwned(
                        advertiserId,
                        lineItemId,
                        targetingType,
                        stampedKeyword,
                      )
                    : Effect.succeed(undefined),
                ),
              );
            current = created ?? undefined;
          }

          if (current === undefined) {
            return yield* new AdvertisersLineItemsTargetingTypesAssignedTargetingOptionNotResolved(
              {
                assignedTargetingOptionId:
                  news.assignedTargetingOptionId ??
                  output?.assignedTargetingOptionId ??
                  userKeyword,
              },
            );
          }

          return toAttrs(current, advertiserId, lineItemId, targetingType);
        }),

        delete: Effect.fn(function* ({ output }) {
          if (
            !output.advertiserId ||
            !output.lineItemId ||
            !output.targetingType ||
            !output.assignedTargetingOptionId
          ) {
            return;
          }
          yield* dv
            .deleteAdvertisersLineItemsTargetingTypesAssignedTargetingOptions({
              advertiserId: output.advertiserId,
              lineItemId: output.lineItemId,
              targetingType: output.targetingType,
              assignedTargetingOptionId: output.assignedTargetingOptionId,
            })
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      },
    );
