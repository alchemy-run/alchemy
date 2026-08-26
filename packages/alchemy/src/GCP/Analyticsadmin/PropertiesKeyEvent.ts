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
  findKeyEventByEventName,
  getKeyEvent,
  hasOwnedEventName,
  ignoreMissing,
  jsonEqual,
  lastSegment,
  listAllProperties,
  listKeyEvents,
  parentOf,
  replaceOnIdentity,
  sameText,
  toEventName,
  toPropertyName,
  updateMaskOf,
} from "./internal.ts";

export type KeyEventDefaultValue = {
  /** Default numeric value applied when the event has no `value` parameter. */
  numericValue?: number;
  /** ISO 4217 currency applied when the event has no currency. */
  currencyCode?: string;
};

export type PropertiesKeyEventProps = {
  /**
   * Parent property. Full name `properties/{property}` or the numeric
   * property id. Immutable — changing it replaces the key event.
   */
  parent: string;
  /**
   * Resource name `properties/{property}/keyEvents/{key_event}` or the
   * key event id. Server-assigned on create. Immutable — changing it
   * replaces the key event.
   */
  keyEventId?: string;
  /**
   * Event name marked as a key event, for example `signup_complete`.
   * Must start with a letter and contain only letters, digits, and
   * underscores (max 40). Immutable — changing it replaces the key
   * event. When omitted, a unique `alc_`-prefixed name is generated so
   * `list` / nuke can identify the row. Key events have no labels or
   * description field.
   */
  eventName?: string;
  /**
   * How key events are counted across events in a session.
   * @default "ONCE_PER_EVENT"
   */
  countingMethod?:
    | analytics.GoogleAnalyticsAdminV1betaKeyEventCountingMethodEnum
    | (string & {});
  /** Default value and currency when the event omits them. */
  defaultValue?: KeyEventDefaultValue;
};

export type PropertiesKeyEvent = Resource<
  "GCP.Analyticsadmin.PropertiesKeyEvent",
  PropertiesKeyEventProps,
  {
    /** Full resource name. */
    name: string;
    /** Key event id (last path segment). */
    keyEventId: string;
    /** Parent property resource name. */
    parent: string;
    /** Project id used when the key event was reconciled. */
    project: string;
    /** Event name. */
    eventName: string | undefined;
    /** Counting method. */
    countingMethod: string | undefined;
    /** Default value, when set. */
    defaultValue: KeyEventDefaultValue | undefined;
    /** Whether this is a custom event. */
    custom: boolean | undefined;
    /** Whether the key event can currently be deleted. */
    deletable: boolean | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Analytics 4 key event on a property.
 *
 * Key events have no labels field. Generated event names use an `alc_`
 * prefix so `list` / nuke can find them. Parent and event name are
 * identity — changing either replaces the key event. Counting method
 * and default value update in place.
 *
 * ### Creating a Key Event
 * **Example:** Generated event name
 * ```typescript
 * const keyEvent = yield* GCP.Analyticsadmin.PropertiesKeyEvent("Signup", {
 *   parent: property.name,
 * });
 * ```
 *
 * **Example:** Explicit event name
 * ```typescript
 * const keyEvent = yield* GCP.Analyticsadmin.PropertiesKeyEvent("Signup", {
 *   parent: property.name,
 *   eventName: "alc_signup",
 *   countingMethod: "ONCE_PER_EVENT",
 * });
 * ```
 *
 * ### Updating a Key Event
 * **Example:** Change counting method
 * ```typescript
 * const keyEvent = yield* GCP.Analyticsadmin.PropertiesKeyEvent("Signup", {
 *   parent: property.name,
 *   keyEventId: existing.keyEventId,
 *   eventName: existing.eventName,
 *   countingMethod: "ONCE_PER_SESSION",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Analyticsadmin
 */
export const PropertiesKeyEvent = Resource<PropertiesKeyEvent>(
  "GCP.Analyticsadmin.PropertiesKeyEvent",
);

export class PropertiesKeyEventNotResolved extends Data.TaggedError(
  "GCP.Analyticsadmin.PropertiesKeyEventNotResolved",
)<{
  name: string;
}> {}

const lookupName = (
  parent: string,
  keyEventId: string | undefined,
  existingName: string | undefined,
) => {
  if (existingName !== undefined && existingName.length > 0) {
    return existingName;
  }
  if (keyEventId !== undefined && keyEventId.length > 0) {
    return keyEventId.includes("/")
      ? keyEventId
      : `${toPropertyName(parent)}/keyEvents/${keyEventId}`;
  }
  return "";
};

const defaultValueOf = (
  value:
    | analytics.GoogleAnalyticsAdminV1betaKeyEventDefaultValue
    | KeyEventDefaultValue
    | undefined,
): KeyEventDefaultValue | undefined => {
  if (value === undefined) return undefined;
  if (value.numericValue === undefined && value.currencyCode === undefined) {
    return undefined;
  }
  return {
    numericValue: value.numericValue,
    currencyCode: value.currencyCode,
  };
};

const toAttrs = (
  event: analytics.GoogleAnalyticsAdminV1betaKeyEvent,
  project: string,
) => {
  const name = event.name ?? "";
  return {
    name,
    keyEventId: lastSegment(name),
    parent: parentOf(name),
    project,
    eventName: event.eventName,
    countingMethod: event.countingMethod,
    defaultValue: defaultValueOf(event.defaultValue),
    custom: event.custom,
    deletable: event.deletable,
    createTime: event.createTime,
  };
};

const isOwnedKeyEvent = (event: analytics.GoogleAnalyticsAdminV1betaKeyEvent) =>
  hasOwnedEventName(event.eventName) ||
  event.custom === true ||
  event.deletable === true;

export const PropertiesKeyEventProvider = () =>
  Provider.succeed(PropertiesKeyEvent, {
    stables: ["name", "keyEventId", "parent", "project", "createTime"],

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
        previousId: olds?.keyEventId ?? output?.keyEventId,
        nextId:
          news.keyEventId !== undefined
            ? lastSegment(news.keyEventId)
            : undefined,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = toPropertyName(olds?.parent ?? output?.parent ?? "");
      const name = lookupName(
        parent,
        olds?.keyEventId ?? output?.keyEventId,
        output?.name,
      );
      let existing = yield* getKeyEvent(name);
      if (existing === undefined && parent.length > 0) {
        const eventName = yield* toEventName(
          id,
          olds?.eventName ?? output?.eventName,
          output?.eventName,
        );
        existing = yield* findKeyEventByEventName(parent, eventName);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return isOwnedKeyEvent(existing) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const properties = yield* listAllProperties();
        const pages = yield* Effect.forEach(
          properties,
          (property) =>
            property.name
              ? listKeyEvents(property.name)
              : Effect.succeed(
                  [] as analytics.GoogleAnalyticsAdminV1betaKeyEvent[],
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
      const defaultValue = defaultValueOf(news.defaultValue);
      const name = lookupName(
        parent,
        news.keyEventId ?? output?.keyEventId,
        output?.name,
      );

      let current = yield* getKeyEvent(name);
      if (current === undefined) {
        current = yield* findKeyEventByEventName(parent, eventName);
      }

      if (current === undefined) {
        const created = yield* analytics
          .createPropertiesKeyEvents({
            parent,
            body: {
              eventName,
              countingMethod,
              defaultValue,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findKeyEventByEventName(parent, eventName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new PropertiesKeyEventNotResolved({
          name: name || eventName,
        });
      }

      const currentName = current.name ?? name;
      const countingChanged = !sameText(current.countingMethod, countingMethod);
      const defaultChanged = !jsonEqual(
        defaultValueOf(current.defaultValue),
        defaultValue,
      );

      const updateMask = updateMaskOf(
        countingChanged ? "counting_method" : undefined,
        defaultChanged && defaultValue !== undefined
          ? "default_value"
          : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* analytics.patchPropertiesKeyEvents({
          name: currentName,
          updateMask,
          body: {
            countingMethod,
            defaultValue,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.name.length === 0) return;
      yield* ignoreMissing(
        analytics.deletePropertiesKeyEvents({ name: output.name }),
      );
    }),
  });
