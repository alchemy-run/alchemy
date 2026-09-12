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
  DEFAULT_FLIGHT,
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

export type InsertionOrderBudgetSegment = {
  /** Optional purchase-order description printed on invoices. */
  description?: string;
  /** Campaign budget this segment draws from. */
  campaignBudgetId?: string;
  /** Budget amount in micros. Must be greater than 0. */
  budgetAmountMicros?: string;
  /** Inclusive date range. Start must be in the future on create. */
  dateRange?: DateRangeValue;
};

export type InsertionOrderBudgetValue = {
  /**
   * Currency or impression budget unit. Immutable.
   * @default "BUDGET_UNIT_CURRENCY"
   */
  budgetUnit?: string;
  /** Budget segments covering the insertion-order flight. */
  budgetSegments?: InsertionOrderBudgetSegment[];
  /**
   * Bid/budget automation type.
   * @default "INSERTION_ORDER_AUTOMATION_TYPE_NONE"
   */
  automationType?: string;
};

export type InsertionOrderKpi = {
  /** KPI type, for example `KPI_TYPE_CPM`. */
  kpiType?: string;
  /** Goal amount in micros of advertiser currency. */
  kpiAmountMicros?: string;
  /** Goal percentage in micros. */
  kpiPercentageMicros?: string;
  /** Free-form KPI when type is `KPI_TYPE_OTHER`. */
  kpiString?: string;
  /** Custom bidding algorithm id for impression-value KPIs. */
  kpiAlgorithmId?: string;
};

export type AdvertisersInsertionOrderProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the
   * insertion order.
   */
  advertiserId: string;
  /**
   * Parent campaign id. Immutable — changing it replaces the insertion
   * order.
   */
  campaignId: string;
  /**
   * System-assigned insertion order id. Omit on create; pass the
   * observed id to update in place.
   */
  insertionOrderId?: string;
  /**
   * Display name (max 240 bytes). Insertion orders have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix.
   */
  displayName?: string;
  /**
   * Serving status. Create accepts only `ENTITY_STATUS_DRAFT`. Activate
   * with a later update.
   * @default "ENTITY_STATUS_DRAFT"
   */
  entityStatus?: string;
  /**
   * Insertion order type.
   * @default "RTB"
   */
  insertionOrderType?: string;
  /**
   * Optimization objective.
   * @default "NO_OBJECTIVE"
   */
  optimizationObjective?: string;
  /** Frequency cap. Defaults to unlimited. */
  frequencyCap?: FrequencyCapValue;
  /** Budget allocation. */
  budget?: InsertionOrderBudgetValue;
  /** Pacing. Defaults to even daily spend. */
  pacing?: PacingValue;
  /** KPI (the UI "Goal"). */
  kpi?: InsertionOrderKpi;
  /** Optional fixed-bid strategy imposed on line items. */
  bidStrategy?: {
    fixedBid?: { bidAmountMicros?: string };
  };
};

export type AdvertisersInsertionOrder = Resource<
  "GCP.Displayvideo.AdvertisersInsertionOrder",
  AdvertisersInsertionOrderProps,
  {
    /** Resource name `advertisers/{advertiser}/insertionOrders/{insertionOrder}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** Parent campaign id. */
    campaignId: string;
    /** System-assigned insertion order id. */
    insertionOrderId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Serving status. */
    entityStatus: string | undefined;
    /** Insertion order type. */
    insertionOrderType: string | undefined;
    /** Optimization objective. */
    optimizationObjective: string | undefined;
    /** Frequency cap. */
    frequencyCap: FrequencyCapValue | undefined;
    /** Budget allocation. */
    budget: InsertionOrderBudgetValue | undefined;
    /** Pacing. */
    pacing: PacingValue | undefined;
    /** KPI. */
    kpi: InsertionOrderKpi | undefined;
    /** Reservation type. */
    reservationType: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 insertion order under a campaign.
 *
 * Insertion orders have no labels field — Alchemy stamps ownership into
 * the display name so `list` / nuke can find them. Advertiser and
 * campaign ids are immutable. Create is always `ENTITY_STATUS_DRAFT`;
 * status, budget, pacing, and KPI update in place.
 *
 * ### Creating an Insertion Order
 * **Example:** Draft RTB insertion order
 * ```typescript
 * const order = yield* GCP.Displayvideo.AdvertisersInsertionOrder("Q1", {
 *   advertiserId: campaign.advertiserId,
 *   campaignId: campaign.campaignId,
 *   displayName: "q1-prospecting",
 *   kpi: { kpiType: "KPI_TYPE_CPM", kpiAmountMicros: "10000000" },
 *   budget: {
 *     budgetUnit: "BUDGET_UNIT_CURRENCY",
 *     budgetSegments: [{ budgetAmountMicros: "1000000" }],
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersInsertionOrder = Resource<AdvertisersInsertionOrder>(
  "GCP.Displayvideo.AdvertisersInsertionOrder",
);

export class AdvertisersInsertionOrderNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersInsertionOrderNotResolved",
)<{
  insertionOrderId: string;
}> {}

const DEFAULT_STATUS = "ENTITY_STATUS_DRAFT";

const defaultBudget = (): InsertionOrderBudgetValue => ({
  budgetUnit: "BUDGET_UNIT_CURRENCY",
  automationType: "INSERTION_ORDER_AUTOMATION_TYPE_NONE",
  budgetSegments: [
    {
      budgetAmountMicros: "1000000",
      dateRange: DEFAULT_FLIGHT,
    },
  ],
});

const defaultKpi = (): InsertionOrderKpi => ({
  kpiType: "KPI_TYPE_CPM",
  kpiAmountMicros: "10000000",
});

const toAttrs = (order: dv.InsertionOrder) => {
  const parsed = parseOwnership(order.displayName);
  return {
    name: order.name ?? "",
    advertiserId: order.advertiserId ?? "",
    campaignId: order.campaignId ?? "",
    insertionOrderId: order.insertionOrderId ?? "",
    displayName: parsed.text,
    entityStatus: order.entityStatus,
    insertionOrderType: order.insertionOrderType,
    optimizationObjective: order.optimizationObjective,
    frequencyCap: order.frequencyCap,
    budget: order.budget,
    pacing: order.pacing,
    kpi: order.kpi,
    reservationType: order.reservationType,
    updateTime: order.updateTime,
  };
};

const getById = (advertiserId: string, insertionOrderId: string | undefined) =>
  !insertionOrderId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersInsertionOrders({ advertiserId, insertionOrderId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string) =>
  dv.listAdvertisersInsertionOrders.pages({ advertiserId, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.insertionOrders ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.InsertionOrder[]),
  );

const findByDisplayName = (advertiserId: string, displayName: string) =>
  listAt(advertiserId).pipe(
    Effect.map((orders) =>
      orders.find((order) => order.displayName === displayName),
    ),
  );

export const AdvertisersInsertionOrderProvider = () =>
  Provider.succeed(AdvertisersInsertionOrder, {
    stables: ["name", "advertiserId", "campaignId", "insertionOrderId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        previousAdvertiser !== undefined &&
        news.advertiserId !== previousAdvertiser
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousCampaign = olds?.campaignId ?? output?.campaignId;
      if (
        previousCampaign !== undefined &&
        news.campaignId !== previousCampaign
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.insertionOrderId ?? output?.insertionOrderId;
      if (
        previousId !== undefined &&
        news.insertionOrderId !== undefined &&
        news.insertionOrderId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      let existing = yield* getById(
        advertiserId,
        olds?.insertionOrderId ?? output?.insertionOrderId,
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
          .filter((order) => hasOwnershipMarker(order.displayName))
          .map(toAttrs);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const advertiserId = news.advertiserId;
      const campaignId = news.campaignId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.displayName,
        parseOwnership(output?.displayName).text,
      );
      const displayName = encodeOwnershipLine(ownership, userName);
      const entityStatus = news.entityStatus ?? DEFAULT_STATUS;
      const insertionOrderType = news.insertionOrderType ?? "RTB";
      const optimizationObjective =
        news.optimizationObjective ?? "NO_OBJECTIVE";
      const frequencyCap = news.frequencyCap ?? defaultUnlimitedCap();
      const budget = news.budget ?? defaultBudget();
      const pacing = news.pacing ?? defaultDailyPacing();
      const kpi = news.kpi ?? defaultKpi();

      let current = yield* getById(
        advertiserId,
        news.insertionOrderId ?? output?.insertionOrderId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(advertiserId, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersInsertionOrders({
            advertiserId,
            body: {
              campaignId,
              displayName,
              entityStatus,
              insertionOrderType,
              optimizationObjective,
              frequencyCap,
              budget,
              pacing,
              kpi,
              bidStrategy: news.bidStrategy,
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
        return yield* new AdvertisersInsertionOrderNotResolved({
          insertionOrderId:
            news.insertionOrderId ?? output?.insertionOrderId ?? displayName,
        });
      }

      const insertionOrderId = current.insertionOrderId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const statusChanged = !sameText(current.entityStatus, entityStatus);
      const typeChanged = !sameText(
        current.insertionOrderType,
        insertionOrderType,
      );
      const objectiveChanged = !sameText(
        current.optimizationObjective,
        optimizationObjective,
      );
      const capChanged = !jsonEqual(current.frequencyCap, frequencyCap);
      const budgetChanged = !jsonEqual(current.budget, budget);
      const pacingChanged = !jsonEqual(current.pacing, pacing);
      const kpiChanged = !jsonEqual(current.kpi, kpi);
      const bidChanged = !jsonEqual(current.bidStrategy, news.bidStrategy);

      if (
        displayChanged ||
        statusChanged ||
        typeChanged ||
        objectiveChanged ||
        capChanged ||
        budgetChanged ||
        pacingChanged ||
        kpiChanged ||
        bidChanged
      ) {
        current = yield* dv.patchAdvertisersInsertionOrders({
          advertiserId,
          insertionOrderId,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            statusChanged ? "entityStatus" : undefined,
            typeChanged ? "insertionOrderType" : undefined,
            objectiveChanged ? "optimizationObjective" : undefined,
            capChanged ? "frequencyCap" : undefined,
            budgetChanged ? "budget" : undefined,
            pacingChanged ? "pacing" : undefined,
            kpiChanged ? "kpi" : undefined,
            bidChanged ? "bidStrategy" : undefined,
          ),
          body: {
            advertiserId,
            insertionOrderId,
            campaignId,
            displayName,
            entityStatus,
            insertionOrderType,
            optimizationObjective,
            frequencyCap,
            budget,
            pacing,
            kpi,
            bidStrategy: news.bidStrategy,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId || !output.insertionOrderId) return;
      yield* dv
        .deleteAdvertisersInsertionOrders({
          advertiserId: output.advertiserId,
          insertionOrderId: output.insertionOrderId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
