import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  eachProfile,
  findByName,
  hasOwnershipMarker,
  jsonEqual,
  listReports,
  ownedByAlchemy,
  ownedName,
  parseOwnership,
  profileIdFromEnv,
  replaceIfChanged,
  sameText,
} from "./internal.ts";

export type ReportType =
  | "STANDARD"
  | "REACH"
  | "PATH_TO_CONVERSION"
  | "FLOODLIGHT"
  | "CROSS_MEDIA_REACH";

export type ReportFormat = "CSV" | "EXCEL";

export type DateRange = {
  /** Inclusive start date (`YYYY-MM-DD`). */
  startDate?: string;
  /** Inclusive end date (`YYYY-MM-DD`). */
  endDate?: string;
  /** Relative window such as `LAST_7_DAYS`. */
  relativeDateRange?: string;
};

export type SortedDimension = {
  /** Dimension name (`dfa:date`, `dfa:advertiser`, …). */
  name?: string;
  /** Sort order (`ASCENDING` or `DESCENDING`). */
  sortOrder?: string;
};

export type DimensionValue = {
  /** Dimension name. */
  dimensionName?: string;
  /** Matched value. */
  value?: string;
  /** Optional id associated with the value. */
  id?: string;
  /** Match type (`EXACT` or `WILDCARD_EXPRESSION`). */
  matchType?: string;
};

export type ReportActivities = {
  /** Floodlight activity metric names. */
  metricNames?: string[];
  /** Activity or activity-group filters. */
  filters?: DimensionValue[];
};

export type ReportCriteria = {
  /** Metric names. */
  metricNames?: string[];
  /** Dimension filters. */
  dimensionFilters?: DimensionValue[];
  /** Standard dimensions. */
  dimensions?: SortedDimension[];
  /** Date range. */
  dateRange?: DateRange;
  /** Floodlight activity group. */
  activities?: ReportActivities;
  /** Custom rich media events. */
  customRichMediaEvents?: { filteredEventIds?: DimensionValue[] };
};

export type ReportReachCriteria = ReportCriteria & {
  /** Reach-by-frequency metric names. */
  reachByFrequencyMetricNames?: string[];
};

export type ReportDelivery = {
  /** Email the report to the owner. */
  emailOwner?: boolean;
  /** Owner delivery type (`LINK` or `ATTACHMENT`). */
  emailOwnerDeliveryType?: string;
  /** Email message. */
  message?: string;
  /** Additional recipients. */
  recipients?: Array<{
    email?: string;
    deliveryType?: string;
  }>;
};

export type ReportSchedule = {
  /** Whether the schedule is active. */
  active?: boolean;
  /** Repeat interval (`DAILY`, `WEEKLY`, `MONTHLY`). */
  repeats?: string;
  /** Repeat every N days/weeks/months. */
  every?: number;
  /** Weekly days to run. */
  repeatsOnWeekDays?: string[];
  /** Monthly recurrence mode. */
  runsOnDayOfMonth?: string;
  /** Timezone. */
  timezone?: string;
  /** Schedule start date. */
  startDate?: string;
  /** Schedule expiration date. */
  expirationDate?: string;
};

export type ReportProps = {
  /**
   * Campaign Manager 360 user profile id. Immutable — changing it
   * replaces the report.
   */
  profileId: string;
  /**
   * System-assigned report id. Omit on create; pass the observed id to
   * update in place.
   */
  id?: string;
  /**
   * Report name. Reports have no labels field, so Alchemy ownership is
   * stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  name?: string;
  /**
   * Report type. Immutable — changing it replaces the report.
   * @default "STANDARD"
   */
  type?: ReportType | string;
  /**
   * Output format.
   * @default "CSV"
   */
  format?: ReportFormat | string;
  /**
   * Filename used when generating report files.
   */
  fileName?: string;
  /**
   * Criteria for `STANDARD` reports. Defaults to last 7 days of
   * impressions by date when omitted.
   */
  criteria?: ReportCriteria;
  /**
   * Criteria for `REACH` reports.
   */
  reachCriteria?: ReportReachCriteria;
  /**
   * Criteria for `PATH_TO_CONVERSION` reports.
   */
  pathToConversionCriteria?: dfa.ReportPathToConversionCriteria;
  /**
   * Criteria for `FLOODLIGHT` reports.
   */
  floodlightCriteria?: dfa.ReportFloodlightCriteria;
  /**
   * Criteria for `CROSS_MEDIA_REACH` reports.
   */
  crossMediaReachCriteria?: dfa.ReportCrossMediaReachCriteria;
  /**
   * Email delivery settings.
   */
  delivery?: ReportDelivery;
  /**
   * Schedule. Only valid with a relative date range other than `TODAY`.
   */
  schedule?: ReportSchedule;
};

export type Report = Resource<
  "GCP.Dfareporting.Report",
  ReportProps,
  {
    /** System-assigned report id. */
    id: string;
    /** User profile id used to manage the report. */
    profileId: string;
    /** Owner profile id. */
    ownerProfileId: string | undefined;
    /** CM360 account id. */
    accountId: string | undefined;
    /** CM360 subaccount id. */
    subAccountId: string | undefined;
    /** User display name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Report type. */
    type: string | undefined;
    /** Output format. */
    format: string | undefined;
    /** Generated filename. */
    fileName: string | undefined;
    /** Standard criteria. */
    criteria: ReportCriteria | undefined;
    /** Reach criteria. */
    reachCriteria: ReportReachCriteria | undefined;
    /** Path-to-conversion criteria. */
    pathToConversionCriteria: dfa.ReportPathToConversionCriteria | undefined;
    /** Floodlight criteria. */
    floodlightCriteria: dfa.ReportFloodlightCriteria | undefined;
    /** Cross-media reach criteria. */
    crossMediaReachCriteria: dfa.ReportCrossMediaReachCriteria | undefined;
    /** Email delivery settings. */
    delivery: ReportDelivery | undefined;
    /** Schedule. */
    schedule: ReportSchedule | undefined;
    /** Last modified timestamp (milliseconds since epoch). */
    lastModifiedTime: string | undefined;
    /** Resource kind (`dfareporting#report`). */
    kind: string | undefined;
  },
  never,
  Providers
>;

const DEFAULT_TYPE: ReportType = "STANDARD";
const DEFAULT_FORMAT: ReportFormat = "CSV";
const DEFAULT_CRITERIA: ReportCriteria = {
  dateRange: { relativeDateRange: "LAST_7_DAYS" },
  dimensions: [{ name: "dfa:date" }],
  metricNames: ["dfa:impressions"],
};

/**
 * A Campaign Manager 360 report definition.
 *
 * Reports have no labels field — Alchemy stamps ownership into `name` so
 * `list` / nuke can find them. Profile id and type are immutable. Name,
 * format, and criteria update in place via PUT.
 *
 * ### Creating a Report
 * **Example:** Standard impressions report
 * ```typescript
 * const report = yield* GCP.Dfareporting.Report("Weekly", {
 *   profileId: "123",
 *   name: "alchemy-weekly",
 *   type: "STANDARD",
 *   criteria: {
 *     dateRange: { relativeDateRange: "LAST_7_DAYS" },
 *     dimensions: [{ name: "dfa:date" }],
 *     metricNames: ["dfa:impressions"],
 *   },
 * });
 * ```
 *
 * ### Updating a Report
 * **Example:** Change the lookback window
 * ```typescript
 * const report = yield* GCP.Dfareporting.Report("Weekly", {
 *   profileId: existing.profileId,
 *   id: existing.id,
 *   name: "alchemy-weekly",
 *   type: "STANDARD",
 *   criteria: {
 *     dateRange: { relativeDateRange: "LAST_30_DAYS" },
 *     dimensions: [{ name: "dfa:date" }],
 *     metricNames: ["dfa:impressions"],
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Dfareporting
 */
export const Report = Resource<Report>("GCP.Dfareporting.Report");

export class ReportNotResolved extends Data.TaggedError(
  "GCP.Dfareporting.ReportNotResolved",
)<{
  profileId: string;
  id: string;
}> {}

const criteriaOf = (
  criteria: dfa.ReportCriteria | undefined,
): ReportCriteria | undefined => {
  if (criteria === undefined) return undefined;
  return {
    metricNames: criteria.metricNames,
    dimensionFilters: criteria.dimensionFilters,
    dimensions: criteria.dimensions,
    dateRange: criteria.dateRange,
    activities: criteria.activities,
    customRichMediaEvents: criteria.customRichMediaEvents,
  };
};

const reachOf = (
  criteria: dfa.ReportReachCriteria | undefined,
): ReportReachCriteria | undefined => {
  if (criteria === undefined) return undefined;
  return {
    ...criteriaOf(criteria),
    reachByFrequencyMetricNames: criteria.reachByFrequencyMetricNames,
  };
};

const toAttrs = (report: dfa.Report, profileId: string) => ({
  id: report.id ?? "",
  profileId,
  ownerProfileId: report.ownerProfileId,
  accountId: report.accountId,
  subAccountId: report.subAccountId,
  name: parseOwnership(report.name).text,
  type: report.type,
  format: report.format,
  fileName: report.fileName,
  criteria: criteriaOf(report.criteria),
  reachCriteria: reachOf(report.reachCriteria),
  pathToConversionCriteria: report.pathToConversionCriteria,
  floodlightCriteria: report.floodlightCriteria,
  crossMediaReachCriteria: report.crossMediaReachCriteria,
  delivery: report.delivery,
  schedule: report.schedule,
  lastModifiedTime: report.lastModifiedTime,
  kind: report.kind,
});

const getById = (profileId: string, id: string | undefined) =>
  !profileId || !id
    ? Effect.succeed(undefined)
    : dfa
        .getReports({ profileId, reportId: id })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (profileId: string, name: string) =>
  listReports(profileId).pipe(
    Effect.map((reports) => findByName(reports, name)),
  );

const desiredBody = (name: string, news: ReportProps): dfa.Report => {
  const type = news.type ?? DEFAULT_TYPE;
  const format = news.format ?? DEFAULT_FORMAT;
  const criteria =
    type === "STANDARD" ? (news.criteria ?? DEFAULT_CRITERIA) : news.criteria;
  return {
    name,
    type,
    format,
    fileName: news.fileName,
    criteria,
    reachCriteria: news.reachCriteria,
    pathToConversionCriteria: news.pathToConversionCriteria,
    floodlightCriteria: news.floodlightCriteria,
    crossMediaReachCriteria: news.crossMediaReachCriteria,
    delivery: news.delivery,
    schedule: news.schedule,
  };
};

export const ReportProvider = () =>
  Provider.succeed(Report, {
    stables: ["id", "profileId", "accountId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const type = news.type ?? DEFAULT_TYPE;
      return (
        replaceIfChanged(
          olds?.profileId ?? output?.profileId,
          news.profileId,
        ) ??
        replaceIfChanged(olds?.type ?? output?.type, type) ??
        replaceIfChanged(olds?.id ?? output?.id, news.id, true)
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const profileId =
        olds?.profileId ?? output?.profileId ?? profileIdFromEnv() ?? "";
      let existing = yield* getById(profileId, olds?.id ?? output?.id);
      if (existing === undefined && profileId) {
        const name = yield* ownedName(
          id,
          olds?.name,
          parseOwnership(output?.name).text,
        );
        existing = yield* findOwned(profileId, name);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, profileId);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      eachProfile((profileId) =>
        listReports(profileId).pipe(
          Effect.map((rows) =>
            rows
              .filter((row) => hasOwnershipMarker(row.name))
              .map((row) => toAttrs(row, profileId)),
          ),
        ),
      ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const profileId = news.profileId;
      const name = yield* ownedName(
        id,
        news.name,
        parseOwnership(output?.name).text,
      );
      const body = desiredBody(name, news);

      let current = yield* getById(profileId, news.id ?? output?.id);
      if (current === undefined) {
        current = yield* findOwned(profileId, name);
      }

      if (current === undefined) {
        const created = yield* dfa
          .insertReports({
            profileId,
            body,
          })
          .pipe(Effect.catchTag("Conflict", () => findOwned(profileId, name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ReportNotResolved({
          profileId,
          id: news.id ?? output?.id ?? name,
        });
      }

      const reportId = current.id ?? "";
      const changed =
        !sameText(current.name, name) ||
        !sameText(current.format, body.format) ||
        !sameText(current.fileName, body.fileName) ||
        !jsonEqual(current.criteria, body.criteria) ||
        !jsonEqual(current.reachCriteria, body.reachCriteria) ||
        !jsonEqual(
          current.pathToConversionCriteria,
          body.pathToConversionCriteria,
        ) ||
        !jsonEqual(current.floodlightCriteria, body.floodlightCriteria) ||
        !jsonEqual(
          current.crossMediaReachCriteria,
          body.crossMediaReachCriteria,
        ) ||
        !jsonEqual(current.delivery, body.delivery) ||
        !jsonEqual(current.schedule, body.schedule);
      if (changed) {
        current = yield* dfa.updateReports({
          profileId,
          reportId,
          body: { ...body, id: reportId },
        });
      }

      return toAttrs(current, profileId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.profileId || !output.id) return;
      yield* dfa
        .deleteReports({
          profileId: output.profileId,
          reportId: output.id,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
