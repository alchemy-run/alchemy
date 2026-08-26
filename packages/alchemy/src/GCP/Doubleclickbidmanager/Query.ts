import * as bidmanager from "@distilled.cloud/gcp/doubleclickbidmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  definitionFromRow,
  definitionOf,
  desiredBody,
  findOwnedQuery,
  getQuery,
  hasOwnershipMarker,
  listOwnedQueries,
  ownedByAlchemy,
  ownedTitle,
  parseTitle,
  replaceIfChanged,
  replaceIfFingerprintChanged,
} from "./internal.ts";

export type QueryDate = {
  /** Year of the date. 1–9999, or 0 when omitted. */
  year?: number;
  /** Month of the year. 1–12, or 0 when omitted. */
  month?: number;
  /** Day of the month. 1–31, or 0 when omitted. */
  day?: number;
};

export type QueryDataRange = {
  /**
   * Preset window (`LAST_7_DAYS`, `LAST_30_DAYS`, `CUSTOM_DATES`, …).
   * @default "LAST_7_DAYS"
   */
  range?: bidmanager.DataRangeRangeEnum | (string & {});
  /** Inclusive start when `range` is `CUSTOM_DATES`. */
  customStartDate?: QueryDate;
  /** Inclusive end when `range` is `CUSTOM_DATES`. */
  customEndDate?: QueryDate;
};

export type QueryFilter = {
  /** Filter type (`FILTER_ADVERTISER`, `FILTER_DATE`, …). */
  type?: string;
  /** Filter value such as an advertiser id. */
  value?: string;
};

export type QueryOptions = {
  /**
   * Limit audience-list rows to lists targeted by filtered line items
   * or insertion orders.
   */
  includeOnlyTargetedUserLists?: boolean;
};

export type QuerySchedule = {
  /**
   * How often the query runs. `ONE_TIME` only runs when
   * `queries.run` is called.
   * @default "ONE_TIME"
   */
  frequency?: bidmanager.QueryScheduleFrequencyEnum | (string & {});
  /** First scheduled run. Required when `frequency` is not `ONE_TIME`. */
  startDate?: QueryDate;
  /** Last scheduled run. Required when `frequency` is not `ONE_TIME`. */
  endDate?: QueryDate;
  /**
   * IANA timezone for scheduled runs.
   * @default "America/New_York"
   */
  nextRunTimezoneCode?: string;
};

export type QueryProps = {
  /**
   * System-assigned query id. Omit on create. Immutable — Bid Manager
   * v2 has no update method, so changing identity or definition
   * replaces the query.
   */
  queryId?: string;
  /**
   * Display name used as the generated report filename. Queries have
   * no labels field, so Alchemy stamps ownership into a `[alchemy …]`
   * prefix and strips it from attributes.
   */
  title?: string;
  /**
   * Report date range.
   * @default { range: "LAST_7_DAYS" }
   */
  dataRange?: QueryDataRange;
  /**
   * Report file format (`CSV` or `XLSX`).
   * @default "CSV"
   */
  format?: bidmanager.QueryMetadataFormatEnum | (string & {});
  /**
   * Email the query creator when a report is ready.
   * @default false
   */
  sendNotification?: boolean;
  /**
   * Extra addresses that receive the ready notification and can open
   * the query in Display and Video 360.
   */
  shareEmailAddress?: string[];
  /**
   * Report type. Determines allowed dimensions, filters, and metrics.
   * @default "STANDARD"
   */
  type?: bidmanager.ParametersTypeEnum | (string & {});
  /**
   * Dimensions that segment the report (`FILTER_DATE`, …).
   * @default ["FILTER_DATE"]
   */
  groupBys?: string[];
  /**
   * Filters that limit reported data.
   */
  filters?: QueryFilter[];
  /**
   * Metrics that populate the report (`METRIC_IMPRESSIONS`, …).
   * @default ["METRIC_IMPRESSIONS"]
   */
  metrics?: string[];
  /**
   * Extra report parameter options.
   */
  options?: QueryOptions;
  /**
   * When and how often the query runs.
   * @default { frequency: "ONE_TIME" }
   */
  schedule?: QuerySchedule;
};

export type Query = Resource<
  "GCP.Doubleclickbidmanager.Query",
  QueryProps,
  {
    /** System-assigned query id. */
    queryId: string;
    /** Project id used when the query was reconciled. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** Report date range. */
    dataRange: QueryDataRange | undefined;
    /** Report file format. */
    format: string | undefined;
    /** Whether a ready-notification email is sent. */
    sendNotification: boolean | undefined;
    /** Extra notification addresses. */
    shareEmailAddress: string[] | undefined;
    /** Report type. */
    type: string | undefined;
    /** Report dimensions. */
    groupBys: string[] | undefined;
    /** Report filters. */
    filters: QueryFilter[] | undefined;
    /** Report metrics. */
    metrics: string[] | undefined;
    /** Extra report parameter options. */
    options: QueryOptions | undefined;
    /** Schedule. */
    schedule: QuerySchedule | undefined;
  },
  never,
  Providers
>;

/**
 * A Display and Video 360 Bid Manager query that generates a report.
 *
 * Queries have no labels field and the v2 API has no update method —
 * Alchemy stamps ownership into `metadata.title` for `list` / nuke,
 * and any definition change replaces the query.
 *
 * ### Creating a Query
 * **Example:** Generated title
 * ```typescript
 * const query = yield* GCP.Doubleclickbidmanager.Query("Weekly", {});
 * ```
 *
 * **Example:** Standard impressions by date
 * ```typescript
 * const query = yield* GCP.Doubleclickbidmanager.Query("Weekly", {
 *   title: "alchemy-weekly",
 *   type: "STANDARD",
 *   dataRange: { range: "LAST_7_DAYS" },
 *   groupBys: ["FILTER_DATE"],
 *   metrics: ["METRIC_IMPRESSIONS"],
 *   format: "CSV",
 *   schedule: { frequency: "ONE_TIME" },
 * });
 * ```
 *
 * ### Replacing a Query
 * **Example:** Change the lookback window
 * ```typescript
 * const query = yield* GCP.Doubleclickbidmanager.Query("Weekly", {
 *   title: "alchemy-weekly",
 *   type: "STANDARD",
 *   dataRange: { range: "LAST_30_DAYS" },
 *   groupBys: ["FILTER_DATE"],
 *   metrics: ["METRIC_IMPRESSIONS"],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Doubleclickbidmanager
 */
export const Query = Resource<Query>("GCP.Doubleclickbidmanager.Query");

export class QueryNotResolved extends Data.TaggedError(
  "GCP.Doubleclickbidmanager.QueryNotResolved",
)<{
  queryId: string;
}> {}

const toAttrs = (row: bidmanager.Query, project: string) => {
  const definition = definitionFromRow(row);
  return {
    queryId: row.queryId ?? "",
    project,
    title: definition.title,
    dataRange: definition.dataRange,
    format: definition.format,
    sendNotification: definition.sendNotification,
    shareEmailAddress:
      definition.shareEmailAddress.length > 0
        ? definition.shareEmailAddress
        : undefined,
    type: definition.type,
    groupBys: definition.groupBys,
    filters: definition.filters,
    metrics: definition.metrics,
    options: definition.options,
    schedule: definition.schedule,
  };
};

const resolvedDefinition = (
  news: QueryProps,
  olds: QueryProps | undefined,
  output: Query["Attributes"] | undefined,
) =>
  definitionOf({
    title: news.title ?? olds?.title ?? output?.title,
    dataRange: news.dataRange ?? olds?.dataRange ?? output?.dataRange,
    format: news.format ?? olds?.format ?? output?.format,
    sendNotification:
      news.sendNotification ??
      olds?.sendNotification ??
      output?.sendNotification,
    shareEmailAddress:
      news.shareEmailAddress ??
      olds?.shareEmailAddress ??
      output?.shareEmailAddress,
    type: news.type ?? olds?.type ?? output?.type,
    groupBys: news.groupBys ?? olds?.groupBys ?? output?.groupBys,
    filters: news.filters ?? olds?.filters ?? output?.filters,
    metrics: news.metrics ?? olds?.metrics ?? output?.metrics,
    options: news.options ?? olds?.options ?? output?.options,
    schedule: news.schedule ?? olds?.schedule ?? output?.schedule,
  });

export const QueryProvider = () =>
  Provider.succeed(Query, {
    stables: ["queryId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return (
        replaceIfChanged(
          olds?.queryId ?? output?.queryId,
          news.queryId,
          true,
        ) ??
        replaceIfFingerprintChanged(
          output !== undefined
            ? definitionOf({
                title: output.title,
                dataRange: output.dataRange,
                format: output.format,
                sendNotification: output.sendNotification,
                shareEmailAddress: output.shareEmailAddress,
                type: output.type,
                groupBys: output.groupBys,
                filters: output.filters,
                metrics: output.metrics,
                options: output.options,
                schedule: output.schedule,
              })
            : olds !== undefined
              ? definitionOf(olds)
              : undefined,
          resolvedDefinition(news, olds, output),
        )
      );
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      let existing = yield* getQuery(olds?.queryId ?? output?.queryId);
      if (existing === undefined) {
        const title = yield* ownedTitle(
          id,
          olds?.title,
          parseTitle(output?.title).title ?? output?.title,
        );
        existing = yield* findOwnedQuery(id, title);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.metadata?.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listOwnedQueries();
        return rows
          .filter((row) => hasOwnershipMarker(row.metadata?.title))
          .map((row) => toAttrs(row, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const definition = resolvedDefinition(news, undefined, output);
      const title = yield* ownedTitle(
        id,
        news.title,
        parseTitle(output?.title).title ?? output?.title,
      );
      const body = desiredBody(title, definition);

      let current = yield* getQuery(news.queryId ?? output?.queryId);
      if (current === undefined) {
        current = yield* findOwnedQuery(id, title);
      }

      if (current === undefined) {
        const created = yield* bidmanager
          .createQueries({ body })
          .pipe(Effect.catchTag("Conflict", () => findOwnedQuery(id, title)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new QueryNotResolved({
          queryId: news.queryId ?? output?.queryId ?? title,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.queryId) return;
      yield* bidmanager
        .deleteQueries({ queryId: output.queryId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
