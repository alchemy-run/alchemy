import * as analytics from "@distilled.cloud/gcp/analyticsadmin_v1beta";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_CURRENCY,
  DEFAULT_PROPERTY_TYPE,
  DEFAULT_TIME_ZONE,
  encodeOwnershipLine,
  findOwnedProperty,
  findPropertyByDisplayName,
  getProperty,
  hasOwnershipMarker,
  ignoreMissing,
  lastSegment,
  listOwnedProperties,
  MAX_PROPERTY_DISPLAY_NAME_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  replaceOnIdentity,
  sameText,
  toAccountName,
  toDisplayName,
  toPropertyName,
  updateMaskOf,
} from "./internal.ts";

export type PropertyProps = {
  /**
   * Parent Google Analytics account. Full name `accounts/{account}` or
   * the numeric account id. Immutable — changing it replaces the
   * property.
   */
  parent: string;
  /**
   * Resource name `properties/{property}` or the numeric property id.
   * Server-assigned on create. Immutable — changing it replaces the
   * property.
   */
  propertyId?: string;
  /**
   * Human-readable display name (max 100 UTF-16 code units including
   * Alchemy's ownership marker). Analytics properties have no labels
   * field, so ownership is stored in a `[alchemy …]` prefix and
   * stripped from attributes.
   */
  displayName?: string;
  /**
   * Reporting time zone used as the day boundary for reports.
   * IANA zone, for example `America/Chicago`.
   * @default "America/Chicago"
   */
  timeZone?: string;
  /**
   * ISO 4217 currency used in reports involving monetary values.
   * @default "USD"
   */
  currencyCode?: string;
  /**
   * Industry associated with this property.
   */
  industryCategory?:
    | analytics.GoogleAnalyticsAdminV1betaPropertyIndustryCategoryEnum
    | (string & {});
  /**
   * Property type. Immutable — changing it replaces the property.
   * Unspecified defaults to `PROPERTY_TYPE_ORDINARY`.
   */
  propertyType?:
    | analytics.GoogleAnalyticsAdminV1betaPropertyPropertyTypeEnum
    | (string & {});
};

export type Property = Resource<
  "GCP.Analyticsadmin.Property",
  PropertyProps,
  {
    /** Full resource name `properties/{property}`. */
    name: string;
    /** Numeric property id (last path segment). */
    propertyId: string;
    /** Parent account or property resource name. */
    parent: string;
    /** Parent account resource name. */
    account: string | undefined;
    /** Project id used when the property was reconciled. */
    project: string;
    /** User-facing display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Reporting time zone. */
    timeZone: string | undefined;
    /** ISO 4217 currency code. */
    currencyCode: string | undefined;
    /** Industry category. */
    industryCategory: string | undefined;
    /** Property type. */
    propertyType: string | undefined;
    /** Google Analytics service level. */
    serviceLevel: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Analytics 4 property.
 *
 * Analytics properties have no labels field, so Alchemy stamps
 * ownership into `displayName` for `list` / nuke. Parent account and
 * property type are identity — changing either replaces the property.
 * Display name, time zone, currency, and industry update in place.
 * Delete moves the property to the trash (soft-delete).
 *
 * ### Creating a Property
 * **Example:** Generated display name
 * ```typescript
 * const property = yield* GCP.Analyticsadmin.Property("Site", {
 *   parent: "accounts/123",
 *   timeZone: "America/Chicago",
 * });
 * ```
 *
 * **Example:** Explicit display name and currency
 * ```typescript
 * const property = yield* GCP.Analyticsadmin.Property("Site", {
 *   parent: "accounts/123",
 *   displayName: "Marketing site",
 *   timeZone: "America/Los_Angeles",
 *   currencyCode: "USD",
 *   industryCategory: "TECHNOLOGY",
 * });
 * ```
 *
 * ### Updating a Property
 * **Example:** Rename and change the time zone
 * ```typescript
 * const property = yield* GCP.Analyticsadmin.Property("Site", {
 *   parent: "accounts/123",
 *   propertyId: existing.propertyId,
 *   displayName: "Marketing site 2026",
 *   timeZone: "America/New_York",
 *   currencyCode: "USD",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Analyticsadmin
 */
export const Property = Resource<Property>("GCP.Analyticsadmin.Property");

export class PropertyNotResolved extends Data.TaggedError(
  "GCP.Analyticsadmin.PropertyNotResolved",
)<{
  name: string;
}> {}

const propertyIdOf = (name: string, propertyId?: string) => {
  if (propertyId !== undefined && propertyId.length > 0) {
    return propertyId.includes("/") ? lastSegment(propertyId) : propertyId;
  }
  if (name.length === 0) return "";
  return lastSegment(name);
};

const lookupName = (
  propertyId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName !== undefined && existingName.length > 0) {
    return toPropertyName(existingName);
  }
  if (propertyId !== undefined && propertyId.length > 0) {
    return toPropertyName(propertyId);
  }
  return "";
};

const toAttrs = (
  property: analytics.GoogleAnalyticsAdminV1betaProperty,
  project: string,
) => {
  const name = property.name ?? "";
  return {
    name,
    propertyId: propertyIdOf(name),
    parent: property.parent ?? property.account ?? "",
    account: property.account,
    project,
    displayName: parseOwnership(property.displayName).text,
    timeZone: property.timeZone,
    currencyCode: property.currencyCode,
    industryCategory: property.industryCategory,
    propertyType: property.propertyType,
    serviceLevel: property.serviceLevel,
    createTime: property.createTime,
    updateTime: property.updateTime,
  };
};

export const PropertyProvider = () =>
  Provider.succeed(Property, {
    stables: [
      "name",
      "propertyId",
      "account",
      "parent",
      "propertyType",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (
        previousParent !== undefined &&
        toAccountName(news.parent) !== toAccountName(previousParent)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType = olds?.propertyType ?? output?.propertyType;
      const nextType = news.propertyType ?? DEFAULT_PROPERTY_TYPE;
      if (
        previousType !== undefined &&
        news.propertyType !== undefined &&
        previousType !== nextType
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return replaceOnIdentity({
        previousId: olds?.propertyId ?? output?.propertyId,
        nextId:
          news.propertyId !== undefined
            ? propertyIdOf("", news.propertyId)
            : undefined,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = lookupName(
        olds?.propertyId ?? output?.propertyId,
        output?.name,
      );
      let existing = yield* getProperty(name);
      if (existing === undefined) {
        existing = yield* findOwnedProperty(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const properties = yield* listOwnedProperties();
        return properties
          .filter((property) => hasOwnershipMarker(property.displayName))
          .map((property) => toAttrs(property, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toAccountName(news.parent);
      const ownership = yield* ownershipLabels(id);
      const rawDisplayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const displayName = encodeOwnershipLine(
        ownership,
        rawDisplayName,
        MAX_PROPERTY_DISPLAY_NAME_LENGTH,
      );
      const timeZone = news.timeZone ?? output?.timeZone ?? DEFAULT_TIME_ZONE;
      const currencyCode =
        news.currencyCode ?? output?.currencyCode ?? DEFAULT_CURRENCY;
      const propertyType =
        news.propertyType ?? output?.propertyType ?? DEFAULT_PROPERTY_TYPE;
      const name = lookupName(
        news.propertyId ?? output?.propertyId,
        output?.name,
      );

      let current = yield* getProperty(name);
      if (current === undefined) {
        current = yield* findOwnedProperty(id);
      }
      if (current === undefined) {
        current = yield* findPropertyByDisplayName(displayName);
      }

      if (current === undefined) {
        const created = yield* analytics
          .createProperties({
            body: {
              parent,
              displayName,
              timeZone,
              currencyCode,
              industryCategory: news.industryCategory,
              propertyType,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findPropertyByDisplayName(displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PropertyNotResolved({
          name: name || displayName,
        });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const zoneChanged = !sameText(current.timeZone, timeZone);
      const currencyChanged = !sameText(current.currencyCode, currencyCode);
      const industryChanged =
        news.industryCategory !== undefined &&
        !sameText(current.industryCategory, news.industryCategory);

      const updateMask = updateMaskOf(
        displayChanged ? "display_name" : undefined,
        zoneChanged ? "time_zone" : undefined,
        currencyChanged ? "currency_code" : undefined,
        industryChanged ? "industry_category" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* analytics.patchProperties({
          name: currentName,
          updateMask,
          body: {
            displayName,
            timeZone,
            currencyCode,
            industryCategory: news.industryCategory,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = output.name;
      if (name.length === 0) return;
      const current = yield* getProperty(name);
      if (current === undefined) return;
      yield* ignoreMissing(analytics.deleteProperties({ name }));
    }),
  });
