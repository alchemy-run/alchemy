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
  DEFAULT_ATTRIBUTION_MODEL,
  DEFAULT_CURRENCY,
  DEFAULT_LOOKBACK_DAYS,
  encodeOwnershipLine,
  getConversionSource,
  hasOwnershipMarker,
  jsonEqual,
  listAccessibleMerchantIds,
  listConversionSourcesAt,
  MAX_CONVERSION_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  parseOwnership,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";

export type AttributionSettings = {
  /** Lookback window in days. Supported values are 7, 30, 40. */
  attributionLookbackWindowInDays?: number;
  /** Attribution model. */
  attributionModel?: string;
};

export type MerchantCenterDestination = {
  /** Attribution settings for the destination. */
  attributionSettings?: AttributionSettings;
  /**
   * Three-letter ISO 4217 currency code conversions are reported in.
   */
  currencyCode?: string;
  /**
   * Display name (max 64 characters). Conversion sources have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  displayName?: string;
};

export type GoogleAnalyticsLink = {
  /** Google Analytics property id. Immutable. */
  propertyId?: string;
};

export type ConversionsourceProps = {
  /**
   * Merchant Center account that owns the conversion source. Immutable —
   * changing it replaces the source.
   */
  merchantId: string;
  /**
   * System-assigned conversion source id (`mcdn:…` or `galk:…`). Omit on
   * create. Immutable — changing it replaces the source.
   */
  conversionSourceId?: string;
  /**
   * Merchant Center tag destination. Mutually exclusive with
   * `googleAnalyticsLink`.
   */
  merchantCenterDestination?: MerchantCenterDestination;
  /**
   * Link to a Google Analytics property. Immutable after create.
   */
  googleAnalyticsLink?: GoogleAnalyticsLink;
};

export type Conversionsource = Resource<
  "GCP.Content.Conversionsource",
  ConversionsourceProps,
  {
    /** Merchant Center account id. */
    merchantId: string;
    /** System-assigned conversion source id. */
    conversionSourceId: string;
    /** Merchant Center destination with ownership prefix stripped. */
    merchantCenterDestination: MerchantCenterDestination | undefined;
    /** Google Analytics property link. */
    googleAnalyticsLink: GoogleAnalyticsLink | undefined;
    /** Current state (`ACTIVE`, `ARCHIVED`, `PENDING`). */
    state: string | undefined;
    /** RFC3339 time when an archived source is permanently deleted. */
    expireTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Merchant Center conversion source.
 *
 * Conversion sources have no labels field — Alchemy stamps ownership into
 * `merchantCenterDestination.displayName` (max 64 characters). `merchantId`
 * and destination kind are identity. Display name, currency, and
 * attribution settings update in place. Delete archives the source for
 * 30 days.
 *
 * ### Creating a Conversion Source
 * **Example:** Merchant Center destination
 * ```typescript
 * const source = yield* GCP.Content.Conversionsource("Purchases", {
 *   merchantId: "123",
 *   merchantCenterDestination: {
 *     displayName: "website-purchases",
 *     currencyCode: "USD",
 *     attributionSettings: {
 *       attributionLookbackWindowInDays: 30,
 *       attributionModel: "CROSS_CHANNEL_LAST_CLICK",
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Content
 */
export const Conversionsource = Resource<Conversionsource>(
  "GCP.Content.Conversionsource",
);

export class ConversionsourceNotResolved extends Data.TaggedError(
  "GCP.Content.ConversionsourceNotResolved",
)<{
  conversionSourceId: string;
}> {}

const destinationOf = (
  destination: content.MerchantCenterDestination | undefined,
): MerchantCenterDestination | undefined => {
  if (destination === undefined) return undefined;
  return {
    attributionSettings: destination.attributionSettings
      ? {
          attributionLookbackWindowInDays:
            destination.attributionSettings.attributionLookbackWindowInDays,
          attributionModel: destination.attributionSettings.attributionModel,
        }
      : undefined,
    currencyCode: destination.currencyCode,
    displayName: parseOwnership(destination.displayName).text,
  };
};

const ownershipText = (source: content.ConversionSource) =>
  source.merchantCenterDestination?.displayName;

const toAttrs = (source: content.ConversionSource, merchantId: string) => ({
  merchantId,
  conversionSourceId: source.conversionSourceId ?? "",
  merchantCenterDestination: destinationOf(source.merchantCenterDestination),
  googleAnalyticsLink: source.googleAnalyticsLink
    ? { propertyId: source.googleAnalyticsLink.propertyId }
    : undefined,
  state: source.state,
  expireTime: source.expireTime,
});

export const ConversionsourceProvider = () =>
  Provider.succeed(Conversionsource, {
    stables: ["merchantId", "conversionSourceId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousMerchant = olds?.merchantId ?? output?.merchantId;
      if (
        previousMerchant !== undefined &&
        news.merchantId !== previousMerchant
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.conversionSourceId ?? output?.conversionSourceId;
      if (
        previousId !== undefined &&
        news.conversionSourceId !== undefined &&
        news.conversionSourceId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousGa =
        olds?.googleAnalyticsLink?.propertyId ??
        output?.googleAnalyticsLink?.propertyId;
      if (
        previousGa !== undefined &&
        news.googleAnalyticsLink?.propertyId !== undefined &&
        news.googleAnalyticsLink.propertyId !== previousGa
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const merchantId = olds?.merchantId ?? output?.merchantId ?? "";
      let existing = yield* getConversionSource(
        merchantId,
        olds?.conversionSourceId ?? output?.conversionSourceId ?? "",
      );
      if (existing === undefined && merchantId) {
        const ownership = yield* createInternalLabels(id);
        const wanted = encodeOwnershipLine(
          ownership,
          olds?.merchantCenterDestination?.displayName,
          MAX_CONVERSION_DISPLAY_NAME_LENGTH,
        );
        const listed = yield* listConversionSourcesAt(merchantId);
        existing = listed.find(
          (item) => item.merchantCenterDestination?.displayName === wanted,
        );
      }
      if (existing === undefined || existing.state === "ARCHIVED") {
        return undefined;
      }
      const attrs = toAttrs(existing, merchantId);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const merchantIds = yield* listAccessibleMerchantIds();
        const pages = yield* Effect.forEach(
          merchantIds,
          (merchantId) => listConversionSourcesAt(merchantId),
          { concurrency: 4 },
        );
        const attrs = [];
        for (let i = 0; i < pages.length; i++) {
          const merchantId = merchantIds[i]!;
          for (const source of pages[i] ?? []) {
            if (source.state === "ARCHIVED") continue;
            if (!hasOwnershipMarker(ownershipText(source))) continue;
            attrs.push(toAttrs(source, merchantId));
          }
        }
        return attrs;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const merchantId = news.merchantId;
      const ownership = yield* createInternalLabels(id);
      const userName = yield* toDisplayName(
        id,
        news.merchantCenterDestination?.displayName,
        output?.merchantCenterDestination?.displayName,
        32,
      );
      const displayName = news.merchantCenterDestination
        ? encodeOwnershipLine(
            ownership,
            userName,
            MAX_CONVERSION_DISPLAY_NAME_LENGTH,
          )
        : undefined;
      const destination: content.MerchantCenterDestination | undefined =
        news.merchantCenterDestination
          ? {
              displayName,
              currencyCode:
                news.merchantCenterDestination.currencyCode ?? DEFAULT_CURRENCY,
              attributionSettings: {
                attributionLookbackWindowInDays:
                  news.merchantCenterDestination.attributionSettings
                    ?.attributionLookbackWindowInDays ?? DEFAULT_LOOKBACK_DAYS,
                attributionModel:
                  news.merchantCenterDestination.attributionSettings
                    ?.attributionModel ?? DEFAULT_ATTRIBUTION_MODEL,
              },
            }
          : undefined;
      const googleAnalyticsLink = news.googleAnalyticsLink
        ? { propertyId: news.googleAnalyticsLink.propertyId }
        : undefined;

      let current = yield* getConversionSource(
        merchantId,
        news.conversionSourceId ?? output?.conversionSourceId ?? "",
      );
      if (current?.state === "ARCHIVED") current = undefined;
      if (current === undefined && displayName) {
        const listed = yield* listConversionSourcesAt(merchantId);
        current = listed.find(
          (item) =>
            item.state !== "ARCHIVED" &&
            item.merchantCenterDestination?.displayName === displayName,
        );
      }

      if (current === undefined) {
        const created = yield* content
          .createConversionsources({
            merchantId,
            body: {
              merchantCenterDestination: destination,
              googleAnalyticsLink,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              displayName
                ? listConversionSourcesAt(merchantId).pipe(
                    Effect.map((items) =>
                      items.find(
                        (item) =>
                          item.merchantCenterDestination?.displayName ===
                          displayName,
                      ),
                    ),
                  )
                : Effect.succeed(undefined),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ConversionsourceNotResolved({
          conversionSourceId:
            news.conversionSourceId ?? output?.conversionSourceId ?? "",
        });
      }

      const conversionSourceId = current.conversionSourceId ?? "";
      const displayChanged = !sameText(
        current.merchantCenterDestination?.displayName,
        displayName,
      );
      const currencyChanged = !sameText(
        current.merchantCenterDestination?.currencyCode,
        destination?.currencyCode,
      );
      const attributionChanged = !jsonEqual(
        {
          attributionLookbackWindowInDays:
            current.merchantCenterDestination?.attributionSettings
              ?.attributionLookbackWindowInDays,
          attributionModel:
            current.merchantCenterDestination?.attributionSettings
              ?.attributionModel,
        },
        destination?.attributionSettings,
      );

      if (
        destination !== undefined &&
        (displayChanged || currencyChanged || attributionChanged)
      ) {
        current = yield* content.patchConversionsources({
          merchantId,
          conversionSourceId,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            currencyChanged ? "currency_code" : undefined,
            attributionChanged ? "attribution_settings" : undefined,
          ),
          body: { merchantCenterDestination: destination },
        });
      }

      return toAttrs(current, merchantId);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.conversionSourceId) return;
      yield* content
        .deleteConversionsources({
          merchantId: output.merchantId,
          conversionSourceId: output.conversionSourceId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
