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
  DEFAULT_COUNTING_METHOD,
  findConversionEventByEventName,
  getConversionEvent,
  hasOwnedEventName,
  ignoreMissing,
  jsonEqual,
  lastSegment,
  listAllProperties,
  listConversionEvents,
  parentOf,
  replaceOnIdentity,
  sameText,
  toEventName,
  toPropertyName,
  updateMaskOf,
} from "./internal.ts";

export type ConversionEventDefaultValue = {
  /** Default value applied when the event has no `value` parameter. */
  value?: number;
  /** ISO 4217 currency applied when the event has no currency. */
  currencyCode?: string;
};

export type PropertiesConversionEventProps = {
  /**
   * Parent property. Full name `properties/{property}` or the numeric
   * property id. Immutable — changing it replaces the conversion event.
   */
  parent: string;
  /**
   * Resource name
   * `properties/{property}/conversionEvents/{conversion_event}` or the
   * conversion event id. Server-assigned on create. Immutable —
   * changing it replaces the conversion event.
   */
  conversionEventId?: string;
  /**
   * Event name marked as a conversion, for example `signup_complete`.
   * Must start with a letter and contain only letters, digits, and
   * underscores (max 40). Immutable — changing it replaces the
   * conversion event. When omitted, a unique `alc_`-prefixed name is
   * generated so `list` / nuke can identify the row. Conversion events
   * have no labels or description field.
   */
  eventName?: string;
  /**
   * How conversions are counted across events in a session.
   * @default "ONCE_PER_EVENT"
   */
  countingMethod?:
    | analytics.GoogleAnalyticsAdminV1betaConversionEventCountingMethodEnum
    | (string & {});
  /** Default value and currency when the event omits them. */
  defaultConversionValue?: ConversionEventDefaultValue;
};

export type PropertiesConversionEvent = Resource<
  "GCP.Analyticsadmin.PropertiesConversionEvent",
  PropertiesConversionEventProps,
  {
    /** Full resource name. */
    name: string;
    /** Conversion event id (last path segment). */
    conversionEventId: string;
    /** Parent property resource name. */
    parent: string;
    /** Project id used when the conversion event was reconciled. */
    project: string;
    /** Event name. */
    eventName: string | undefined;
    /** Counting method. */
    countingMethod: string | undefined;
    /** Default conversion value, when set. */
    defaultConversionValue: ConversionEventDefaultValue | undefined;
    /** Whether this is a custom event. */
    custom: boolean | undefined;
    /** Whether the conversion event can currently be deleted. */
    deletable: boolean | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Analytics 4 conversion event on a property.
 *
 * Conversion events have no labels field. Generated event names use an
 * `alc_` prefix so `list` / nuke can find them. Parent and event name
 * are identity — changing either replaces the conversion event.
 * Counting method and default value update in place. This API is
 * deprecated in favor of key events; both are implemented.
 *
 * ### Creating a Conversion Event
 * **Example:** Generated event name
 * ```typescript
 * const conversion = yield* GCP.Analyticsadmin.PropertiesConversionEvent(
 *   "Signup",
 *   { parent: property.name },
 * );
 * ```
 *
 * **Example:** Explicit event name
 * ```typescript
 * const conversion = yield* GCP.Analyticsadmin.PropertiesConversionEvent(
 *   "Signup",
 *   {
 *     parent: property.name,
 *     eventName: "alc_signup",
 *     countingMethod: "ONCE_PER_EVENT",
 *   },
 * );
 * ```
 *
 * ### Updating a Conversion Event
 * **Example:** Change counting method
 * ```typescript
 * const conversion = yield* GCP.Analyticsadmin.PropertiesConversionEvent(
 *   "Signup",
 *   {
 *     parent: property.name,
 *     conversionEventId: existing.conversionEventId,
 *     eventName: existing.eventName,
 *     countingMethod: "ONCE_PER_SESSION",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Analyticsadmin
 */
export const PropertiesConversionEvent = Resource<PropertiesConversionEvent>(
  "GCP.Analyticsadmin.PropertiesConversionEvent",
);

export class PropertiesConversionEventNotResolved extends Data.TaggedError(
  "GCP.Analyticsadmin.PropertiesConversionEventNotResolved",
)<{
  name: string;
}> {}

const lookupName = (
  parent: string,
  conversionEventId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName !== undefined && existingName.length > 0) {
    return existingName;
  }
  if (conversionEventId !== undefined && conversionEventId.length > 0) {
    return conversionEventId.includes("/")
      ? conversionEventId
      : `${toPropertyName(parent)}/conversionEvents/${conversionEventId}`;
  }
  return "";
};

const defaultValueOf = (
  value:
    | analytics.GoogleAnalyticsAdminV1betaConversionEventDefaultConversionValue
    | ConversionEventDefaultValue
    | undefined,
): ConversionEventDefaultValue | undefined => {
  if (value === undefined) return undefined;
  if (value.value === undefined && value.currencyCode === undefined) {
    return undefined;
  }
  return {
    value: value.value,
    currencyCode: value.currencyCode,
  };
};

const toAttrs = (
  event: analytics.GoogleAnalyticsAdminV1betaConversionEvent,
  project: string,
) => {
  const name = event.name ?? "";
  return {
    name,
    conversionEventId: lastSegment(name),
    parent: parentOf(name),
    project,
    eventName: event.eventName,
    countingMethod: event.countingMethod,
    defaultConversionValue: defaultValueOf(event.defaultConversionValue),
    custom: event.custom,
    deletable: event.deletable,
    createTime: event.createTime,
  };
};

const isOwnedConversion = (
  event: analytics.GoogleAnalyticsAdminV1betaConversionEvent,
) =>
  hasOwnedEventName(event.eventName) ||
  event.custom === true ||
  event.deletable === true;

export const PropertiesConversionEventProvider = () =>
  Provider.succeed(PropertiesConversionEvent, {
    stables: ["name", "conversionEventId", "parent", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (
        previousParent !== undefined &&
        toPropertyName(news.parent) !== toPropertyName(previousParent)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousEvent = olds?.eventName ?? output?.eventName;
      if (
        previousEvent !== undefined &&
        news.eventName !== undefined &&
        news.eventName !== previousEvent
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return replaceOnIdentity({
        previousId: olds?.conversionEventId ?? output?.conversionEventId,
        nextId:
          news.conversionEventId !== undefined
            ? lastSegment(news.conversionEventId)
            : undefined,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toPropertyName(olds?.parent ?? output?.parent ?? "");
      const name = lookupName(
        parent,
        olds?.conversionEventId ?? output?.conversionEventId,
        output?.name,
      );
      let existing = yield* getConversionEvent(name);
      if (existing === undefined && parent.length > 0) {
        const eventName = yield* toEventName(
          id,
          olds?.eventName ?? output?.eventName,
          output?.eventName,
        );
        existing = yield* findConversionEventByEventName(parent, eventName);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return isOwnedConversion(existing) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const properties = yield* listAllProperties();
        const pages = yield* Effect.forEach(
          properties,
          (property) =>
            property.name
              ? listConversionEvents(property.name)
              : Effect.succeed(
                  [] as analytics.GoogleAnalyticsAdminV1betaConversionEvent[],
                ),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((event) => hasOwnedEventName(event.eventName))
          .map((event) => toAttrs(event, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toPropertyName(news.parent);
      const eventName = yield* toEventName(
        id,
        news.eventName,
        output?.eventName,
      );
      const countingMethod =
        news.countingMethod ??
        output?.countingMethod ??
        DEFAULT_COUNTING_METHOD;
      const defaultConversionValue = defaultValueOf(
        news.defaultConversionValue,
      );
      const name = lookupName(
        parent,
        news.conversionEventId ?? output?.conversionEventId,
        output?.name,
      );

      let current = yield* getConversionEvent(name);
      if (current === undefined) {
        current = yield* findConversionEventByEventName(parent, eventName);
      }

      if (current === undefined) {
        const created = yield* analytics
          .createPropertiesConversionEvents({
            parent,
            body: {
              eventName,
              countingMethod,
              defaultConversionValue,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findConversionEventByEventName(parent, eventName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PropertiesConversionEventNotResolved({
          name: name || eventName,
        });
      }

      const currentName = current.name ?? name;
      const countingChanged = !sameText(current.countingMethod, countingMethod);
      const defaultChanged = !jsonEqual(
        defaultValueOf(current.defaultConversionValue),
        defaultConversionValue,
      );

      const updateMask = updateMaskOf(
        countingChanged ? "counting_method" : undefined,
        defaultChanged && defaultConversionValue !== undefined
          ? "default_conversion_value"
          : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* analytics.patchPropertiesConversionEvents({
          name: currentName,
          updateMask,
          body: {
            countingMethod,
            defaultConversionValue,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* ignoreMissing(
        analytics.deletePropertiesConversionEvents({ name: output.name }),
      );
    }),
  });
