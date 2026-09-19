import * as content from "@distilled.cloud/gcp/content_v2_1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_CONTENT_TYPE,
  encodeOwnershipLine,
  getDatafeed,
  hasOwnershipMarker,
  jsonEqual,
  listAccessibleMerchantIds,
  listDatafeedsAt,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  toResourceId,
} from "./internal.ts";

export type DatafeedTarget = {
  /** Deprecated. Use `feedLabel` instead. */
  country?: string;
  /** Target countries (CLDR territory codes). */
  targetCountries?: string[];
  /** ISO 639-1 language of items in the feed. */
  language?: string;
  /** Feed label (max 20 uppercase letters, digits, dashes). */
  feedLabel?: string;
  /** Destinations to exclude. */
  excludedDestinations?: string[];
  /** Destinations to include. */
  includedDestinations?: string[];
};

export type DatafeedFetchSchedule = {
  /** Fetch URL (HTTP, HTTPS, FTP, or SFTP). */
  fetchUrl?: string;
  /** Optional username. */
  username?: string;
  /** Optional password. */
  password?: string;
  /** Hour of day (0-23). */
  hour?: number;
  /** Day of month (1-31) for monthly fetches. */
  dayOfMonth?: number;
  /** Weekday for weekly fetches. */
  weekday?: string;
  /** Time zone (for example `America/Los_Angeles`). */
  timeZone?: string;
  /** Whether the scheduled fetch is paused. */
  paused?: boolean;
};

export type DatafeedFormat = {
  /** File encoding (`utf-8`, `latin-1`, …). */
  fileEncoding?: string;
  /** Quoting mode. */
  quotingMode?: string;
  /** Column delimiter (`tab`, `pipe`, `tilde`). */
  columnDelimiter?: string;
};

export type DatafeedProps = {
  /**
   * Merchant Center account that manages the feed. Cannot be a
   * multi-client account. Immutable — changing it replaces the feed.
   */
  merchantId: string;
  /**
   * Datafeed id. Assigned on create. Immutable — changing it replaces
   * the feed.
   */
  datafeedId?: string;
  /**
   * Descriptive name. Datafeeds have no labels field, so Alchemy
   * ownership is stored in a `[alchemy …]` prefix and stripped from
   * attributes.
   */
  name?: string;
  /**
   * Feed type (`products`, `local products`, `product inventory`).
   * @default "products"
   */
  contentType?: string;
  /**
   * Unique filename of the feed. Generated when omitted.
   */
  fileName?: string;
  /**
   * Language of attributes in the feed (ISO 639-1).
   */
  attributeLanguage?: string;
  /**
   * Targets (country, language, destinations).
   */
  targets?: DatafeedTarget[];
  /**
   * Fetch schedule.
   */
  fetchSchedule?: DatafeedFetchSchedule;
  /**
   * File format.
   */
  format?: DatafeedFormat;
};

export type Datafeed = Resource<
  "GCP.Content.Datafeed",
  DatafeedProps,
  {
    /** Merchant Center account id. */
    merchantId: string;
    /** Datafeed id. */
    datafeedId: string;
    /** Descriptive name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Feed type. */
    contentType: string | undefined;
    /** Filename. */
    fileName: string | undefined;
    /** Attribute language. */
    attributeLanguage: string | undefined;
    /** Targets. */
    targets: DatafeedTarget[] | undefined;
    /** Fetch schedule (password omitted). */
    fetchSchedule: DatafeedFetchSchedule | undefined;
    /** File format. */
    format: DatafeedFormat | undefined;
  },
  never,
  Providers
>;

/**
 * A Merchant Center datafeed configuration.
 *
 * Datafeeds have no labels field — Alchemy stamps ownership into `name`.
 * `merchantId` is identity; `datafeedId` is assigned on insert. Name,
 * filename, targets, schedule, and format update in place via a
 * full-document PUT.
 *
 * ### Creating a Datafeed
 * **Example:** Products feed
 * ```typescript
 * const feed = yield* GCP.Content.Datafeed("Catalog", {
 *   merchantId: "123",
 *   name: "primary-products",
 *   contentType: "products",
 *   fileName: "products.txt",
 *   targets: [{ language: "en", feedLabel: "US" }],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const Datafeed = Resource<Datafeed>("GCP.Content.Datafeed");

export class DatafeedNotResolved extends Data.TaggedError(
  "GCP.Content.DatafeedNotResolved",
)<{
  merchantId: string;
  datafeedId: string;
}> {}

const scheduleOf = (
  schedule: content.DatafeedFetchSchedule | undefined,
): DatafeedFetchSchedule | undefined => {
  if (schedule === undefined) return undefined;
  return {
    fetchUrl: schedule.fetchUrl,
    username: schedule.username,
    hour: schedule.hour,
    dayOfMonth: schedule.dayOfMonth,
    weekday: schedule.weekday,
    timeZone: schedule.timeZone,
    paused: schedule.paused,
  };
};

const toAttrs = (feed: content.Datafeed, merchantId: string) => {
  const parsed = parseOwnership(feed.name);
  return {
    merchantId,
    datafeedId: feed.id ?? "",
    name: parsed.text,
    contentType: feed.contentType,
    fileName: feed.fileName,
    attributeLanguage: feed.attributeLanguage,
    targets: feed.targets,
    fetchSchedule: scheduleOf(feed.fetchSchedule),
    format: feed.format,
  };
};

export const DatafeedProvider = () =>
  Provider.succeed(Datafeed, {
    stables: ["merchantId", "datafeedId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      if (
        previousMerchant !== undefined &&
        news.merchantId !== previousMerchant
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.datafeedId ?? output?.datafeedId;
      if (
        previousId !== undefined &&
        news.datafeedId !== undefined &&
        news.datafeedId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      let existing = yield* getDatafeed(
        merchantId,
        olds?.datafeedId ?? output?.datafeedId ?? "",
      );
      if (existing === undefined && merchantId) {
        const ownership = yield* createInternalLabels(id);
        const wanted = encodeOwnershipLine(ownership, olds?.name);
        const listed = yield* listDatafeedsAt(merchantId);
        existing = listed.find((item) => item.name === wanted);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, merchantId);
      return (yield* ownedByAlchemy(id, existing.name))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const merchantIds = yield* listAccessibleMerchantIds();
        const pages = yield* Effect.forEach(
          merchantIds,
          (merchantId) => listDatafeedsAt(merchantId),
          { concurrency: 4 },
        );
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const merchantId = merchantIds[i]!;
          for (const feed of pages[i] ?? []) {
            if (!hasOwnershipMarker(feed.name)) continue;
            attrs.push(toAttrs(feed, merchantId));
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const merchantId = news.merchantId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.name,
        parseOwnership(output?.name).text,
      );
      const name = encodeOwnershipLine(ownership, userName);
      const fileName =
        news.fileName ??
        output?.fileName ??
        `${yield* toResourceId(id, undefined, undefined, 40)}.txt`;
      const contentType = news.contentType ?? DEFAULT_CONTENT_TYPE;
      const body: content.Datafeed = {
        name,
        fileName,
        contentType,
        attributeLanguage: news.attributeLanguage,
        targets: news.targets,
        fetchSchedule: news.fetchSchedule,
        format: news.format,
      };

      let current = yield* getDatafeed(
        merchantId,
        news.datafeedId ?? output?.datafeedId ?? "",
      );
      if (current === undefined) {
        const listed = yield* listDatafeedsAt(merchantId);
        current = listed.find((item) => item.name === name);
      }

      if (current === undefined) {
        const created = yield* content
          .insertDatafeeds({ merchantId, body })
          .pipe(
            Effect.catchTag("Conflict", () =>
              listDatafeedsAt(merchantId).pipe(
                Effect.map((items) => items.find((item) => item.name === name)),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DatafeedNotResolved({
          merchantId,
          datafeedId: news.datafeedId ?? output?.datafeedId ?? "",
        });
      }

      const datafeedId = current.id ?? "";
      const changed =
        !sameText(current.name, name) ||
        !sameText(current.fileName, fileName) ||
        !sameText(current.contentType, contentType) ||
        !sameText(current.attributeLanguage, news.attributeLanguage) ||
        !jsonEqual(current.targets, news.targets) ||
        !jsonEqual(
          scheduleOf(current.fetchSchedule),
          scheduleOf(news.fetchSchedule),
        ) ||
        !jsonEqual(current.format, news.format);

      if (changed) {
        current = yield* content.updateDatafeeds({
          merchantId,
          datafeedId,
          body: { ...body, id: datafeedId },
        });
      }

      return toAttrs(current, merchantId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.datafeedId) return;
      yield* content
        .deleteDatafeeds({
          merchantId: output.merchantId,
          datafeedId: output.datafeedId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
