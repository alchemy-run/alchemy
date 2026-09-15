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
  updateMaskOf,
} from "./ownership.ts";

export type CampaignPerformanceGoal = {
  /** Performance goal type, for example `PERFORMANCE_GOAL_TYPE_CPM`. */
  performanceGoalType?: string;
  /** Goal amount in micros of advertiser currency. */
  performanceGoalAmountMicros?: string;
  /** Goal percentage in micros (70000 = 7%). */
  performanceGoalPercentageMicros?: string;
  /** Free-form KPI when type is `PERFORMANCE_GOAL_TYPE_OTHER`. */
  performanceGoalString?: string;
};

export type CampaignGoalValue = {
  /** Campaign goal type, for example `CAMPAIGN_GOAL_TYPE_BRAND_AWARENESS`. */
  campaignGoalType?: string;
  /** Performance goal used to measure the campaign. */
  performanceGoal?: CampaignPerformanceGoal;
};

export type CampaignBudgetValue = {
  /** Inclusive flight of this budget. */
  dateRange?: DateRangeValue;
  /** `BUDGET_UNIT_CURRENCY` or `BUDGET_UNIT_IMPRESSIONS`. Immutable. */
  budgetUnit?: string;
  /** External budget id. */
  externalBudgetId?: string;
  /** Display name of the budget. */
  displayName?: string;
  /** System-assigned budget id. Required when updating existing budgets. */
  budgetId?: string;
  /** Total amount in micros. */
  budgetAmountMicros?: string;
  /** Invoice grouping id. */
  invoiceGroupingId?: string;
  /**
   * External budget source.
   * @default "EXTERNAL_BUDGET_SOURCE_NONE"
   */
  externalBudgetSource?: string;
};

export type CampaignFlightValue = {
  /** Planned spend in micros. Does not cap serving. */
  plannedSpendAmountMicros?: string;
  /** Planned dates. `startDate` is required and must be today or later. */
  plannedDates?: DateRangeValue;
};

export type AdvertisersCampaignProps = {
  /**
   * Parent advertiser id. Immutable — changing it replaces the campaign.
   */
  advertiserId: string;
  /**
   * System-assigned campaign id. Omit on create; pass the observed id
   * to update in place.
   */
  campaignId?: string;
  /**
   * Display name (max 240 bytes). Campaigns have no labels field, so
   * Alchemy ownership is stored in a `[alchemy …]` prefix.
   */
  displayName?: string;
  /**
   * Serving status. Create accepts `ENTITY_STATUS_ACTIVE` and
   * `ENTITY_STATUS_PAUSED`.
   * @default "ENTITY_STATUS_PAUSED"
   */
  entityStatus?: string;
  /**
   * Campaign goal and performance goal.
   */
  campaignGoal: CampaignGoalValue;
  /**
   * Frequency cap. Defaults to unlimited.
   */
  frequencyCap?: FrequencyCapValue;
  /**
   * Planned spend and duration. Dates are relative to the advertiser
   * time zone and do not affect serving.
   */
  campaignFlight?: CampaignFlightValue;
  /**
   * Optional budgets. Omitted means unlimited budget.
   */
  campaignBudgets?: CampaignBudgetValue[];
};

export type AdvertisersCampaign = Resource<
  "GCP.Displayvideo.AdvertisersCampaign",
  AdvertisersCampaignProps,
  {
    /** Resource name `advertisers/{advertiser}/campaigns/{campaign}`. */
    name: string;
    /** Parent advertiser id. */
    advertiserId: string;
    /** System-assigned campaign id. */
    campaignId: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Serving status. */
    entityStatus: string | undefined;
    /** Campaign goal. */
    campaignGoal: CampaignGoalValue | undefined;
    /** Frequency cap. */
    frequencyCap: FrequencyCapValue | undefined;
    /** Planned flight. */
    campaignFlight: CampaignFlightValue | undefined;
    /** Campaign budgets. */
    campaignBudgets: CampaignBudgetValue[] | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 campaign under an advertiser.
 *
 * Campaigns have no labels field — Alchemy stamps ownership into the
 * display name so `list` / nuke can find them. Advertiser id is
 * immutable. Status, goal, frequency cap, flight, and budgets update in
 * place.
 *
 * ### Creating a Campaign
 * **Example:** Paused brand-awareness campaign
 * ```typescript
 * const campaign = yield* GCP.Displayvideo.AdvertisersCampaign("Spring", {
 *   advertiserId: advertiser.advertiserId,
 *   displayName: "spring-awareness",
 *   campaignGoal: {
 *     campaignGoalType: "CAMPAIGN_GOAL_TYPE_BRAND_AWARENESS",
 *     performanceGoal: {
 *       performanceGoalType: "PERFORMANCE_GOAL_TYPE_CPM",
 *       performanceGoalAmountMicros: "10000000",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Displayvideo
 */
export const AdvertisersCampaign = Resource<AdvertisersCampaign>(
  "GCP.Displayvideo.AdvertisersCampaign",
);

export class AdvertisersCampaignNotResolved extends Data.TaggedError(
  "GCP.Displayvideo.AdvertisersCampaignNotResolved",
)<{
  campaignId: string;
}> {}

const DEFAULT_STATUS = "ENTITY_STATUS_PAUSED";

const toAttrs = (campaign: dv.Campaign) => {
  const parsed = parseOwnership(campaign.displayName);
  return {
    name: campaign.name ?? "",
    advertiserId: campaign.advertiserId ?? "",
    campaignId: campaign.campaignId ?? "",
    displayName: parsed.text,
    entityStatus: campaign.entityStatus,
    campaignGoal: campaign.campaignGoal,
    frequencyCap: campaign.frequencyCap,
    campaignFlight: campaign.campaignFlight,
    campaignBudgets: campaign.campaignBudgets,
    updateTime: campaign.updateTime,
  };
};

const getById = (advertiserId: string, campaignId: string | undefined) =>
  !campaignId
    ? Effect.succeed(undefined)
    : dv
        .getAdvertisersCampaigns({ advertiserId, campaignId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (advertiserId: string) =>
  dv.listAdvertisersCampaigns.pages({ advertiserId, pageSize: 200 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.campaigns ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    ignoreList([] as dv.Campaign[]),
  );

const findByDisplayName = (advertiserId: string, displayName: string) =>
  listAt(advertiserId).pipe(
    Effect.map((campaigns) =>
      campaigns.find((campaign) => campaign.displayName === displayName),
    ),
  );

export const AdvertisersCampaignProvider = () =>
  Provider.succeed(AdvertisersCampaign, {
    stables: ["name", "advertiserId", "campaignId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAdvertiser = olds?.advertiserId ?? output?.advertiserId;
      if (
        previousAdvertiser !== undefined &&
        news.advertiserId !== previousAdvertiser
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.campaignId ?? output?.campaignId;
      if (
        previousId !== undefined &&
        news.campaignId !== undefined &&
        news.campaignId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const advertiserId = olds?.advertiserId ?? output?.advertiserId ?? "";
      let existing = yield* getById(
        advertiserId,
        olds?.campaignId ?? output?.campaignId,
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
          .filter((campaign) => hasOwnershipMarker(campaign.displayName))
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
      const entityStatus = news.entityStatus ?? DEFAULT_STATUS;
      const frequencyCap = news.frequencyCap ?? defaultUnlimitedCap();
      const campaignFlight = news.campaignFlight ?? {
        plannedDates: DEFAULT_FLIGHT,
      };

      let current = yield* getById(
        advertiserId,
        news.campaignId ?? output?.campaignId,
      );
      if (current === undefined) {
        current = yield* findByDisplayName(advertiserId, displayName);
      }

      if (current === undefined) {
        const created = yield* dv
          .createAdvertisersCampaigns({
            advertiserId,
            body: {
              displayName,
              entityStatus,
              campaignGoal: news.campaignGoal,
              frequencyCap,
              campaignFlight,
              campaignBudgets: news.campaignBudgets,
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
        return yield* new AdvertisersCampaignNotResolved({
          campaignId: news.campaignId ?? output?.campaignId ?? displayName,
        });
      }

      const campaignId = current.campaignId ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const statusChanged = !sameText(current.entityStatus, entityStatus);
      const goalChanged = !jsonEqual(current.campaignGoal, news.campaignGoal);
      const capChanged = !jsonEqual(current.frequencyCap, frequencyCap);
      const flightChanged = !jsonEqual(current.campaignFlight, campaignFlight);
      const budgetsChanged = !jsonEqual(
        current.campaignBudgets,
        news.campaignBudgets,
      );

      if (
        displayChanged ||
        statusChanged ||
        goalChanged ||
        capChanged ||
        flightChanged ||
        budgetsChanged
      ) {
        current = yield* dv.patchAdvertisersCampaigns({
          advertiserId,
          campaignId,
          updateMask: updateMaskOf(
            displayChanged ? "displayName" : undefined,
            statusChanged ? "entityStatus" : undefined,
            goalChanged ? "campaignGoal" : undefined,
            capChanged ? "frequencyCap" : undefined,
            flightChanged ? "campaignFlight" : undefined,
            budgetsChanged ? "campaignBudgets" : undefined,
          ),
          body: {
            advertiserId,
            campaignId,
            displayName,
            entityStatus,
            campaignGoal: news.campaignGoal,
            frequencyCap,
            campaignFlight,
            campaignBudgets: news.campaignBudgets,
          },
        });
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.advertiserId || !output.campaignId) return;
      yield* dv
        .deleteAdvertisersCampaigns({
          advertiserId: output.advertiserId,
          campaignId: output.campaignId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
