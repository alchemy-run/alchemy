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
  defaultDailyPacing,
  defaultUnlimitedCap,
  encodeOwnershipLine,
  hasOwnershipMarker,
  ignoreList,
  jsonEqual,
  listOwnedAdvertiserIds,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  type DateRangeValue,
  type FrequencyCapValue,
  type PacingValue,
  updateMaskOf,
} from "./ownership.ts";

export type LineItemFlightValue = {
  /**
   * `LINE_ITEM_FLIGHT_DATE_TYPE_INHERITED` or
   * `LINE_ITEM_FLIGHT_DATE_TYPE_CUSTOM`.
   */
  flightDateType?: string;
  /** Required when flight type is custom. */
  dateRange?: DateRangeValue;
};

export type LineItemBudgetValue = {
  /** Inherited budget unit. */
  budgetUnit?: string;
  /** Max amount in micros or impressions when allocation is fixed. */
  maxAmount?: string;
  /**
   * Budget allocation type.
   * @default "LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED"
   */
  budgetAllocationType?: string;
};

export type LineItemPartnerRevenueModel = {
  /** Markup type. */
  markupType?: string;
  /** Markup amount (micros or millis depending on type). */
  markupAmount?: string;
};

export type LineItemBidStrategy = {
  /** Fixed bid in micros of advertiser currency. */
  fixedBid?: { bidAmountMicros?: string };
  /** Demand Gen bid strategy. */
  demandGenBid?: { type?: string; value?: string };
};

export type AdvertisersLineItemProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the line
   * item.
   */
  advertiserId: string;
  /**
   * Parent insertion order id. Immutable — changing it replaces the
   * line item.
   */
  insertionOrderId: string;
  /**
   * System-assigned line item id. Omit on create; pass the observed id
   * to update in place.
   */
  lineItemId?: string;
  /**
   * Display name (max 240 bytes). Line items have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix.
   */
  displayName?: string;
  /**
   * Line item type. Immutable.
   * @default "LINE_ITEM_TYPE_DISPLAY_DEFAULT"
   */
  lineItemType?: string;
  /**
   * Serving status. Create accepts only `ENTITY_STATUS_DRAFT`.
   * @default "ENTITY_STATUS_DRAFT"
   */
  entityStatus?: string;
  /**
   * EU political advertising status. Required on create.
   * @default "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"
   */
  containsEuPoliticalAds?: string;
  /** Bidding strategy. Defaults to a 1.00 currency-unit fixed bid. */
  bidStrategy?: LineItemBidStrategy;
  /**
   * Flight. Defaults to inheriting the insertion-order dates.
   */
  flight?: LineItemFlightValue;
  /** Budget allocation. */
  budget?: LineItemBudgetValue;
  /** Frequency cap. Defaults to unlimited. */
  frequencyCap?: FrequencyCapValue;
  /** Pacing. Defaults to even daily spend. */
  pacing?: PacingValue;
  /** Partner revenue model. */
  partnerRevenueModel?: LineItemPartnerRevenueModel;
  /** Associated creative ids. */
  creativeIds?: string[];
  /** Exclude newly added exchanges from targeting. */
  excludeNewExchanges?: boolean;
};

export type AdvertisersLineItem = Resource<
  "GCP.Displayvideo.AdvertisersLineItem",
  AdvertisersLineItemProps,
  {
    /** Resource name `advertisers/{advertiser}/lineItems/{lineItem}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** Parent insertion order id. */
    insertionOrderId: string;
    /** Parent campaign id. */
    campaignId: string | undefined;
    /** System-assigned line item id. */
    lineItemId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Line item type. */
    lineItemType: string | undefined;
    /** Serving status. */
    entityStatus: string | undefined;
    /** EU political advertising status. */
    containsEuPoliticalAds: string | undefined;
    /** Bidding strategy. */
    bidStrategy: LineItemBidStrategy | undefined;
    /** Flight. */
    flight: LineItemFlightValue | undefined;
    /** Budget allocation. */
    budget: LineItemBudgetValue | undefined;
    /** Frequency cap. */
    frequencyCap: FrequencyCapValue | undefined;
    /** Pacing. */
    pacing: PacingValue | undefined;
    /** Partner revenue model. */
    partnerRevenueModel: LineItemPartnerRevenueModel | undefined;
    /** Associated creative ids. */
    creativeIds: string[] | undefined;
    /** Reservation type. */
    reservationType: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 line item under an insertion order.
 *
 * Line items have no labels field — Alchemy stamps ownership into the
 * display name so `list` / nuke can find them. Advertiser, insertion
 * order, and line-item type are immutable. Create is always
 * `ENTITY_STATUS_DRAFT`; status, bid, flight, and budget update in
 * place. YouTube and Partners line items cannot be created via the API.
 *
 * ### Creating a Line Item
 * **Example:** Draft display line item
 * ```typescript
 * const lineItem = yield* GCP.Displayvideo.AdvertisersLineItem("Prospect", {
 *   advertiserId: order.advertiserId,
 *   insertionOrderId: order.insertionOrderId,
 *   displayName: "prospecting-display",
 *   lineItemType: "LINE_ITEM_TYPE_DISPLAY_DEFAULT",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersLineItem = Resource<AdvertisersLineItem>(
  "GCP.Displayvideo.AdvertisersLineItem",
);

export class AdvertisersLineItemNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersLineItemNotResolved",
)<{
  lineItemId: string;
}> {}

const DEFAULT_STATUS = "ENTITY_STATUS_DRAFT";
const DEFAULT_TYPE = "LINE_ITEM_TYPE_DISPLAY_DEFAULT";
const DEFAULT_EU = "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING";

const defaultBid = (): LineItemBidStrategy => ({
  fixedBid: { bidAmountMicros: "1000000" },
});

const defaultFlight = (): LineItemFlightValue => ({
  flightDateType: "LINE_ITEM_FLIGHT_DATE_TYPE_INHERITED",
});

const defaultBudget = (): LineItemBudgetValue => ({
  budgetAllocationType: "LINE_ITEM_BUDGET_ALLOCATION_TYPE_UNLIMITED",
});

const defaultRevenue = (): LineItemPartnerRevenueModel => ({
  markupType: "PARTNER_REVENUE_MODEL_MARKUP_TYPE_TOTAL_MEDIA_COST_MARKUP",
  markupAmount: "0",
});

const toAttrs = (item: dv.LineItem) => {
  const parsed = parseOwnership(item.displayName);
  return {
    name: item.name ?? "",
    advertiserId: item.advertiserId ?? "",
    insertionOrderId: item.insertionOrderId ?? "",
    campaignId: item.campaignId,
    lineItemId: item.lineItemId ?? "",
    displayName: parsed.text,
    lineItemType: item.lineItemType,
    entityStatus: item.entityStatus,
    containsEuPoliticalAds: item.containsEuPoliticalAds,
    bidStrategy: item.bidStrategy,
    flight: item.flight,
    budget: item.budget,
    frequencyCap: item.frequencyCap,
    pacing: item.pacing,
    partnerRevenueModel: item.partnerRevenueModel,
    creativeIds: item.creativeIds,
    reservationType: item.reservationType,
    updateTime: item.updateTime,
  };
};

const getById = (advertiserId: string, lineItemId: string | undefined) =>
  !lineItemId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersLineItems({ advertiserId, lineItemId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string) =>
  dv.listAdvertisersLineItems.pages({ advertiserId, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.lineItems ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.LineItem[]),
  );

const findByDisplayName = (advertiserId: string, displayName: string) =>
  listAt(advertiserId).pipe(
    Effect.map((items) =>
      items.find((item) => item.displayName === displayName),
    ),
  );

export const AdvertisersLineItemProvider = () =>
  Provider.succeed(AdvertisersLineItem, {
    stables: [
      "name",
      "advertiserId",
      "insertionOrderId",
      "campaignId",
      "lineItemId",
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
      const previousOrder = olds?.insertionOrderId ?? output?.insertionOrderId;
      if (
        previousOrder !== undefined &&
        news.insertionOrderId !== previousOrder
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType = olds?.lineItemType ?? output?.lineItemType;
      if (
        previousType !== undefined &&
        news.lineItemType !== undefined &&
        news.lineItemType !== previousType
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousId = olds?.lineItemId ?? output?.lineItemId;
      if (
        previousId !== undefined &&
        news.lineItemId !== undefined &&
        news.lineItemId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      let existing = yield* getById(
        advertiserId,
        olds?.lineItemId ?? output?.lineItemId,
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
        const advertiserIds = yield* listOwnedAdvertiserIds();
        const pages = yield* Effect.forEach(
          advertiserIds,
          (advertiserId) => listAt(advertiserId),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((item) => hasOwnershipMarker(item.displayName))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const advertiserId = news.advertiserId;
      const insertionOrderId = news.insertionOrderId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);
      const entityStatus = news.entityStatus ?? DEFAULT_STATUS;
      const lineItemType = news.lineItemType ?? DEFAULT_TYPE;
      const containsEuPoliticalAds = news.containsEuPoliticalAds ?? DEFAULT_EU;
      const bidStrategy = news.bidStrategy ?? defaultBid();
      const flight = news.flight ?? defaultFlight();
      const budget = news.budget ?? defaultBudget();
      const frequencyCap = news.frequencyCap ?? defaultUnlimitedCap();
      const pacing = news.pacing ?? defaultDailyPacing();
      const partnerRevenueModel = news.partnerRevenueModel ?? defaultRevenue();

      let current = yield* getById(
        advertiserId,
        news.lineItemId ?? output?.lineItemId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(advertiserId, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersLineItems({
            advertiserId,
            body: {
              insertionOrderId,
              displayName,
              entityStatus,
              lineItemType,
              containsEuPoliticalAds,
              bidStrategy,
              flight,
              budget,
              frequencyCap,
              pacing,
              partnerRevenueModel,
              creativeIds: news.creativeIds,
              excludeNewExchanges: news.excludeNewExchanges,
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
        return yield* new AdvertisersLineItemNotResolved({
          lineItemId: news.lineItemId ?? output?.lineItemId ?? displayName,
        });
      }

      const lineItemId = current.lineItemId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const statusChanged = !sameText(current.entityStatus, entityStatus);
      const euChanged = !sameText(
        current.containsEuPoliticalAds,
        containsEuPoliticalAds,
      );
      const bidChanged = !jsonEqual(current.bidStrategy, bidStrategy);
      const flightChanged = !jsonEqual(current.flight, flight);
      const budgetChanged = !jsonEqual(current.budget, budget);
      const capChanged = !jsonEqual(current.frequencyCap, frequencyCap);
      const pacingChanged = !jsonEqual(current.pacing, pacing);
      const revenueChanged = !jsonEqual(
        current.partnerRevenueModel,
        partnerRevenueModel,
      );
      const creativesChanged = !jsonEqual(
        current.creativeIds,
        news.creativeIds,
      );
      const excludeChanged =
        (current.excludeNewExchanges === true) !==
        (news.excludeNewExchanges === true);

      if (
        displayChanged ||
        statusChanged ||
        euChanged ||
        bidChanged ||
        flightChanged ||
        budgetChanged ||
        capChanged ||
        pacingChanged ||
        revenueChanged ||
        creativesChanged ||
        excludeChanged
      ) {
        current = yield* dv.patchAdvertisersLineItems({
          advertiserId,
          lineItemId,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            statusChanged ? "entityStatus" : undefined,
            euChanged ? "containsEuPoliticalAds" : undefined,
            bidChanged ? "bidStrategy" : undefined,
            flightChanged ? "flight" : undefined,
            budgetChanged ? "budget" : undefined,
            capChanged ? "frequencyCap" : undefined,
            pacingChanged ? "pacing" : undefined,
            revenueChanged ? "partnerRevenueModel" : undefined,
            creativesChanged ? "creativeIds" : undefined,
            excludeChanged ? "excludeNewExchanges" : undefined,
          ),
          body: {
            advertiserId,
            lineItemId,
            insertionOrderId,
            displayName,
            entityStatus,
            containsEuPoliticalAds,
            bidStrategy,
            flight,
            budget,
            frequencyCap,
            pacing,
            partnerRevenueModel,
            creativeIds: news.creativeIds,
            excludeNewExchanges: news.excludeNewExchanges,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId || !output.lineItemId) return;
      yield* dv
        .deleteAdvertisersLineItems({
          advertiserId: output.advertiserId,
          lineItemId: output.lineItemId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
